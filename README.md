# ds-vs-ds

极简 DeepSeek 拟人形象投票页。

- 网页：https://kurosawageeker.github.io/ds-vs-ds/
- 静态网页由 GitHub Pages 托管，API 使用独立的 Cloudflare Worker + D1。
- 手机和电脑均为两图并列；图片完整显示、不裁切。左图来自小红书 @ZIWWWWWW，右图按站点提供者要求标注「AI 生成，原作者不详」。图片版权归各自权利人，不随源码授予使用许可。
- 每 3 秒自动读取共享票数，切回页面时立即刷新。隐藏页面暂停请求；网络错误保留上次结果并自动重试。
- 随机浏览器 UUID 保存在 localStorage，服务端唯一约束保证同一 ID 只能投一次。D1 事务和触发器保证计数一致，不存 IP。清除存储、换浏览器或人为构造 ID 可以绕过限制，因此不适用于严肃选举或需要强身份验证的评选。

## 开发与发布

使用 Node.js 22+ 与 Wrangler 4。静态文件在 `docs/`，后端在 `api/`。无需前端构建或运行时依赖。

```sh
npm run check
wrangler d1 execute ds-vs-ds-votes --local --config api/wrangler.jsonc --file api/schema.sql
npm run dev:api
# 另一个终端执行，测试仅用于本地数据库：
npm test
```

生产数据库初始化与 API 发布：

```sh
wrangler d1 execute ds-vs-ds-votes --remote --config api/wrangler.jsonc --file api/schema.sql
npm run deploy:api
```

GitHub Pages 从 `feat/voting-site` 分支的 `/docs` 目录发布。`docs/` 同时是前端源文件与发布目录：更新后提交并推送即可。后端需要单独发布。不要把 .env、令牌、Wrangler 本地状态或日志提交到仓库。

## 验证

API 集成测试覆盖正常投票、重复/并发投票、跨站请求限制、无效参数和超长请求体。按站点提供者要求，不使用浏览器、computer use 或截图做渲染检查。
