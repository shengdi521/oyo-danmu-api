#!/bin/sh
set -eu

RELEASE_ARCHIVE=${1:-/tmp/oyo-danmu-api.tar.gz}
RELEASE_SHA=${2:-unknown}
NODE_VERSION=${NODE_VERSION:-24.19.0}
NODE_SHA256=${NODE_SHA256:-f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4}
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root." >&2
  exit 1
fi
if [ ! -f "$RELEASE_ARCHIVE" ]; then
  echo "Release archive not found: $RELEASE_ARCHIVE" >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
app_root="/opt/oyo-danmu-api"
release_dir="${app_root}/releases/${stamp}-${RELEASE_SHA}"
shared_cache="${app_root}/shared/cache"
node_root="/opt/node-v${NODE_VERSION}-linux-x64"

install -d -m 0755 "${app_root}/releases" "${app_root}/shared" /etc/danmu-api
if ! id danmu-api >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin danmu-api
fi

if [ ! -d "$shared_cache" ]; then
  install -d -o danmu-api -g danmu-api -m 0750 "$shared_cache"
  if [ -L "${app_root}/current" ]; then
    previous_release=$(readlink -f "${app_root}/current" || true)
    if [ -n "$previous_release" ] && [ -d "${previous_release}/.cache" ]; then
      cp -a "${previous_release}/.cache/." "$shared_cache/"
    fi
  fi
fi
chown -R danmu-api:danmu-api "$shared_cache"
chmod 0750 "$shared_cache"

if [ ! -x "$node_root/bin/node" ]; then
  tmp_node=$(mktemp -d)
  trap 'rm -rf "$tmp_node"' EXIT INT TERM
  wget -q "$NODE_URL" -O "$tmp_node/$NODE_ARCHIVE"
  printf '%s  %s\n' "$NODE_SHA256" "$tmp_node/$NODE_ARCHIVE" | sha256sum -c -
  tar -xzf "$tmp_node/$NODE_ARCHIVE" -C /opt
  rm -rf "$tmp_node"
  trap - EXIT INT TERM
fi
ln -sfn "$node_root/bin/node" /usr/local/bin/node
ln -sfn "$node_root/bin/npm" /usr/local/bin/npm
ln -sfn "$node_root/bin/npx" /usr/local/bin/npx

install -d -m 0755 "$release_dir"
tar -xzf "$RELEASE_ARCHIVE" -C "$release_dir"
install -d -o danmu-api -g danmu-api -m 0750 "$release_dir/config"
if [ -d "$release_dir/.cache" ] && [ ! -L "$release_dir/.cache" ]; then
  rmdir "$release_dir/.cache"
fi
ln -s "$shared_cache" "$release_dir/.cache"
chown -R root:root "$release_dir"
chown -R danmu-api:danmu-api "$release_dir/config" "$shared_cache"
chown -h danmu-api:danmu-api "$release_dir/.cache"

cd "$release_dir"
npm ci --omit=dev --ignore-scripts
chown -R root:root "$release_dir/node_modules"
ln -sfn "$release_dir" "${app_root}/current"
chown -h root:root "${app_root}/current"

if [ -f /etc/danmu-api/danmu-api.env ]; then
  cp -p /etc/danmu-api/danmu-api.env "/etc/danmu-api/danmu-api.env.backup-${stamp}"
else
  admin_token=$(openssl rand -hex 32)
  umask 077
  cat > /etc/danmu-api/danmu-api.env <<EOF
NODE_ENV=production
DANMU_API_PORT=9321
DANMU_API_HOST=127.0.0.1
DANMU_PROXY_HOST=127.0.0.1
DANMU_API_PUBLIC_PROTO=https
TOKEN=87654321
ADMIN_TOKEN=${admin_token}
SOURCE_ORDER=tencent,bilibili,iqiyi,youku,imgo,migu,leshi,sohu,xigua,hongguo,dandan
VOD_REQUEST_TIMEOUT=5000
SEARCH_REQUEST_DEADLINE_MS=8000
SEARCH_CACHE_MINUTES=15
COMMENT_CACHE_MINUTES=30
MAX_ANIMES=1000
EOF
fi
chmod 0600 /etc/danmu-api/danmu-api.env

install -m 0644 "$release_dir/ops/danmu-api.service" /etc/systemd/system/danmu-api.service
systemctl daemon-reload
systemctl enable danmu-api.service
systemctl restart danmu-api.service

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 http://127.0.0.1:9321/ >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    journalctl -u danmu-api.service -n 80 --no-pager >&2
    exit 1
  fi
  sleep 1
done

printf 'release=%s\nnode=%s\n' "$release_dir" "$(node --version)"
systemctl is-active danmu-api.service
