#!/bin/sh
set -eu

RELEASE_ARCHIVE=${1:-/tmp/oyo-danmu-api.tar.gz}
RELEASE_SHA=${2:-unknown}
NODE_VERSION=${NODE_VERSION:-24.19.0}
NODE_SHA256=${NODE_SHA256:-14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647}
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
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
release_dir="/opt/oyo-danmu-api/releases/${stamp}-${RELEASE_SHA}"
node_root="/opt/node-v${NODE_VERSION}-linux-x64"

install -d -m 0755 /opt/oyo-danmu-api/releases /etc/danmu-api
if ! id danmu-api >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin danmu-api
fi

if [ ! -x "$node_root/bin/node" ]; then
  tmp_node=$(mktemp -d)
  trap 'rm -rf "$tmp_node"' EXIT INT TERM
  wget -q "$NODE_URL" -O "$tmp_node/$NODE_ARCHIVE"
  printf '%s  %s\n' "$NODE_SHA256" "$tmp_node/$NODE_ARCHIVE" | sha256sum -c -
  tar -xJf "$tmp_node/$NODE_ARCHIVE" -C /opt
  rm -rf "$tmp_node"
  trap - EXIT INT TERM
fi
ln -sfn "$node_root/bin/node" /usr/local/bin/node
ln -sfn "$node_root/bin/npm" /usr/local/bin/npm
ln -sfn "$node_root/bin/npx" /usr/local/bin/npx

install -d -m 0755 "$release_dir"
tar -xzf "$RELEASE_ARCHIVE" -C "$release_dir"
install -d -o danmu-api -g danmu-api -m 0750 "$release_dir/config" "$release_dir/.cache"
chown -R root:root "$release_dir"
chown -R danmu-api:danmu-api "$release_dir/config" "$release_dir/.cache"

cd "$release_dir"
npm ci --omit=dev --ignore-scripts
chown -R root:root "$release_dir/node_modules"
ln -sfn "$release_dir" /opt/oyo-danmu-api/current
chown -h root:root /opt/oyo-danmu-api/current

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
SOURCE_ORDER=tencent,bilibili1,qiyi,youku,mgtv,imgo,migu,leshi,sohu,xigua,hongguo,dandan
SEARCH_CACHE_TTL_SECONDS=21600
COMMENT_CACHE_TTL_SECONDS=21600
CACHE_MAX_ANIMES=5000
CACHE_MAX_EPISODES=20000
EOF
fi
chmod 0600 /etc/danmu-api/danmu-api.env

install -m 0644 "$release_dir/ops/danmu-api.service" /etc/systemd/system/danmu-api.service
systemctl daemon-reload
systemctl enable --now danmu-api.service

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
