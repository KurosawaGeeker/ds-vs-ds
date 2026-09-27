# ds-vs-ds

极简 DeepSeek 拟人形象投票页。

- 网页：https://ds-vs-ds.win/
- 备用地址：https://ds-vs-ds.pages.dev/
- 静态网页由 Cloudflare Pages 托管，API 使用独立的 Cloudflare Worker + D1。
- 手机和电脑均为两图并列；图片完整显示、不裁切。左图来自小红书 @ZIWWWWWW。右图署名为：二创 ZipZipPipe，原作角色上善无形「溟月」。公开资料显示，上善无形在 2025 年 6 月创作「溟月」，ZipZipPipe 于 2026 年 4 月 25 日在此基础上加入 DeepSeek 元素并做出女仆鲸鱼娘二创；当前吃白饭图片的最初发布帖未找到，因此页面不把单张文件的绘制者表述得超出证据。图片版权归各自权利人，不随源码授予使用许可。
- 每 5 秒读取共享票数，边缘节点最多每 10 秒刷新数据库结果。个人投票状态只在首次加载或提交结果不确定时查询；隐藏页面暂停请求。断线保留上次结果，按 10/20/40/60 秒退避重试，并尊重服务器的 Retry-After。
- 投票必须通过 Turnstile，后端验证一次性令牌、hostname、action 和浏览器 ID 绑定。随机 UUID 唯一约束和 D1 事务保证同一 ID 只计一票。IP 仅用于边缘限流和 Cloudflare 验证，不写入投票数据库。
- 提交入口每个 IP 每分钟允许 5 次尝试；通过验证的提交每个 Cloudflare 节点每分钟最多 120 次。个人状态查询每个 IP 每分钟 30 次、每个节点每分钟 300 次；公共票数不进行个人身份查询。限流为 Cloudflare 的节点级近似限制，并非全球严格配额。人机验证不能证明一人一票，不适用于严肃选举。

## 开发与发布

使用 Node.js 24+ 与 Wrangler 4。静态文件在 `docs/`，后端在 `api/`。无需前端构建或运行时依赖。

```sh
npm run check
npm test
# 可选的本地 Worker 调试：
wrangler d1 execute ds-vs-ds-votes --local --config api/wrangler.jsonc --file api/schema.sql
npm run dev:api
```

新建数据库时才初始化 schema；现有站点升级无需迁移或重置票数。API 发布：

```sh
npm run deploy:api
```

网页发布命令：`wrangler pages deploy docs --project-name ds-vs-ds --branch feat/voting-site`。这是 Direct Upload 项目，推送 GitHub 不会自动发布到 Cloudflare。

GitHub Pages 已停用，GitHub 仓库仅保存源码。前端与后端分别发布到 Cloudflare。不要把 .env、令牌、Wrangler 本地状态或日志提交到仓库。

主站 API 路由为 `https://ds-vs-ds.win/api/*`，避免浏览器访问 workers.dev。旧 Worker 地址仍执行相同验证，不能绕过护栏。Turnstile 允许的域名是 `ds-vs-ds.win` 和 `ds-vs-ds.pages.dev`；公开 sitekey 在前端，私密 `TURNSTILE_SECRET_KEY` 通过标准输入上传至 Worker secret。生产中没有跳过验证的开关。

## 验证

测试执行实际 SQLite schema 和 SQL，覆盖重复/并发投票、令牌重放、hostname/action/ID 不匹配、限流、缓存降级与前端验证和退避。外部 Turnstile 服务及限流绑定使用桩，不能替代真人完成验证的端到端验收。线上只做无效投票拒绝和只读 HTTP 检查，不添加测试票。按站点提供者要求，不使用浏览器、computer use 或截图做渲染检查。

## 费用保护

API 单次 CPU 上限为 50ms，日志采样率为 1%。这些限制不能限制请求总量或保证月账单封顶。每个持续打开的页面每分钟约发起 12 次缓存查询；隐藏页面暂停查询。公共缓存保留最多一天，数据库故障时明确标记为上次票数。静态 Pages 资源不调用 Functions。数据库与 Workers 仍按账号套餐计费，未更改账号订阅。

2026-09-27 排查时 D1 返回 `7429: D1 DB is overloaded. Requests queued for too long.`，保护上线后读取恢复。保留原有 4,559,229 票（左 1,448,682，右 3,110,547），未追溯删除。最近 10,000 条记录集中在 UTC 02:05:15–02:06:15，其中左 1,915 票、右 8,085 票，属于可疑高频模式。历史记录没有 IP 或人机验证证据，不能据此准确判定刷票数量。上线 HTTP 检查连续 20 次读取成功，未验证请求返回 403，复用连接的限流检查第 6 次起返回 429；无测试票写入。

迁移复用原有数据库，已有票数保留；浏览器本地身份按域名隔离，旧域名的已投票状态不会自动转移到新域名。
