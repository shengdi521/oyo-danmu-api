#!/bin/sh
set -eu

TUNNEL_ID=${TUNNEL_ID:?TUNNEL_ID is required}
CREDENTIALS_FILE=${CREDENTIALS_FILE:-/etc/danmu-api/tunnel-credentials.json}
CLOUDFLARED_BIN=${CLOUDFLARED_BIN:-/etc/sing-box/cloudflared}

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root." >&2
  exit 1
fi
if [ ! -s "$CREDENTIALS_FILE" ]; then
  echo "Tunnel credentials file is missing." >&2
  exit 1
fi
if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "cloudflared binary is missing." >&2
  exit 1
fi

install -d -m 0755 /etc/danmu-api
chown nobody:nogroup "$CREDENTIALS_FILE"
umask 077
cat > /etc/danmu-api/cloudflared-danmu.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}
protocol: http2
ingress:
  - service: http://127.0.0.1:9321
    originRequest:
      httpHostHeader: danmu.oyo131.xyz
EOF

cat > /etc/systemd/system/cloudflared-danmu.service <<'EOF'
[Unit]
Description=Cloudflare Tunnel for oyo131 danmu origin
After=network-online.target danmu-api.service
Wants=network-online.target

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=/etc/sing-box/cloudflared tunnel --no-autoupdate --config /etc/danmu-api/cloudflared-danmu.yml run
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
MemoryMax=96M
TasksMax=64

[Install]
WantedBy=multi-user.target
EOF

chmod 0600 "$CREDENTIALS_FILE" /etc/danmu-api/cloudflared-danmu.yml
chown nobody:nogroup /etc/danmu-api/cloudflared-danmu.yml
systemctl daemon-reload
systemctl enable --now cloudflared-danmu.service
sleep 4
systemctl is-active cloudflared-danmu.service
