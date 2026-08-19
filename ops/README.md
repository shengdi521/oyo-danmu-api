# VPS 生产部署说明

目标拓扑：

`播放器 -> danmu.oyo131.xyz (Worker) -> Workers VPC Service -> Cloudflare Tunnel -> Node 127.0.0.1:9321`

VPS 不开放弹幕 Web 端口。Worker 通过绑定 `oyo-danmu-origin` 的 VPC Service，经专用 Cloudflare Tunnel 访问 Node；Node 主服务和内部代理分别只监听 `127.0.0.1:9321`、`127.0.0.1:5321`。

生产 Secret 和 token 只存在于：

- Cloudflare Worker Secret `ORIGIN_SHARED_SECRET`
- VPS `/etc/danmu-api/danmu-api.env`（权限 `0600`）
- VPS `/etc/danmu-api/origin-shared-secret`（权限 `0600`）
- VPS Tunnel credentials（权限 `0600`）

生产源顺序将官方/稳定中文源放在前面，公开动漫补充源放在最后；`bahamut,niconico` 已完成搜索、分集和时间轴弹幕三段实测。仅能搜索但无法取得时间轴弹幕的候选源不进入生产顺序。

仓库内的模板不包含真实值。VPS 上保留旧版本目录和 systemd 单元备份，升级失败时将 `/opt/oyo-danmu-api/current` 恢复到前一版本并重启 `danmu-api.service`。
