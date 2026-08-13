# oyo131 弹幕 API 边缘网关

生产入口：`https://danmu.oyo131.xyz`

该 Worker 只负责固定源站代理、分级边缘缓存、CORS、安全过滤、健康检查和按客户端限流。完整弹幕抓取逻辑运行在 VPS 上的 Node 服务中，避免 Cloudflare Workers 免费套餐的外部子请求上限影响多源抓取。

## 安全边界

- Worker Secret `ORIGIN_SHARED_SECRET` 与 VPS Nginx 中的值必须一致。
- `danmu-origin.oyo131.xyz` 只接受带该请求头的流量。
- 日志、配置、部署、Cookie 和收藏写操作不通过公网网关开放。
- 直链和分片接口仅接受已知媒体域名，拒绝本机、私网和任意代理目标。
- `.dev.vars`、VPS `.env`、隧道 token 和任何媒体 Cookie 都不能提交到 Git。

## 常用命令

```powershell
npm run test:edge
npm run edge:types
npm run edge:dry-run
npm run edge:deploy
```

部署前通过 `npx wrangler secret put ORIGIN_SHARED_SECRET --config edge-gateway/wrangler.jsonc` 交互写入 Secret，禁止把值放在命令参数或配置文件中。
