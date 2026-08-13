# VPS 生产部署说明

目标拓扑：

`播放器 -> danmu.oyo131.xyz (Worker) -> danmu-origin.oyo131.xyz:443 (Cloudflare IPv6 proxy) -> Nginx -> Node 127.0.0.1:9321`

源站只监听公网 IPv6 的 TLS 443，Nginx 仅允许 Cloudflare 官方 IPv6 段访问，并同时校验 Worker 注入的共享密钥。Node 主服务和内部代理分别只监听 `127.0.0.1:9321`、`127.0.0.1:5321`。

生产 Secret 和 token 只存在于：

- Cloudflare Worker Secret `ORIGIN_SHARED_SECRET`
- VPS `/etc/danmu-api/danmu-api.env`（权限 `0600`）
- VPS `/etc/danmu-api/origin-shared-secret`（权限 `0600`）
- VPS Cloudflare Origin TLS 私钥（权限 `0600`）

仓库内的模板不包含真实值。VPS 上保留旧版本目录和 systemd 单元备份，升级失败时将 `/opt/oyo-danmu-api/current` 恢复到前一版本并重启 `danmu-api.service`。
