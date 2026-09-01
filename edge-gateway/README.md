# oyo131 弹幕 API 边缘网关

生产入口：`https://danmu.oyo131.xyz`

该 Worker 只负责固定源站代理、分级边缘缓存、CORS、安全过滤、健康检查和按客户端限流。完整弹幕抓取逻辑运行在 VPS 上的 Node 服务中，避免 Cloudflare Workers 免费套餐的外部子请求上限影响多源抓取。稳定 GET 接口同时保留 24 小时边缘备份；短期缓存过期时先返回最近一次成功结果，再后台刷新，避免多源冷搜索阻塞播放端。

## 安全边界

- Worker 通过专用 Workers VPC Service 和 Cloudflare Tunnel 访问源站，VPS 不开放弹幕 Web 端口。
- `ORIGIN_SHARED_SECRET` 仍作为纵深防御的内部请求标记，只保存为 Worker Secret。
- 日志、配置、部署和 Cookie 等管理操作只允许通过持有 `ADMIN_PATH_TOKEN` 的专用路径访问；无令牌管理路径和错误令牌统一返回 404。
- 管理页面和管理 API 强制 `no-store`、`no-referrer`，不允许跨域读取或嵌入。
- 直链和分片接口仅接受已知媒体域名，拒绝本机、私网和任意代理目标。
- `.dev.vars`、VPS `.env`、隧道 token 和任何媒体 Cookie 都不能提交到 Git。

## 常用命令

```powershell
npm run test:edge
npm run edge:types
npm run edge:dry-run
npm run edge:deploy
```

部署前分别通过以下命令交互写入 Secret，禁止把值放在命令参数或配置文件中：

```powershell
npx wrangler secret put ORIGIN_SHARED_SECRET --config edge-gateway/wrangler.jsonc
npx wrangler secret put ADMIN_PATH_TOKEN --config edge-gateway/wrangler.jsonc
```

`ADMIN_PATH_TOKEN` 必须与源站的 `ADMIN_TOKEN` 保持一致。后台入口为 `https://danmu.oyo131.xyz/{ADMIN_PATH_TOKEN}`，不要把真实链接写入源码、日志或公开文档。
