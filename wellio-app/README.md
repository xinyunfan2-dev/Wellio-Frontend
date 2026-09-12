# Wellio frontend

TanStack Start + React + TypeScript，沿用已确认的 Wellio B 视觉系统。

前端仓库：[Wellio](https://github.com/xinyunfan2-dev/Wellio)。后端独立仓库：[Wellio-Backend](https://github.com/xinyunfan2-dev/Wellio-Backend)，采用 **FastAPI + PostgreSQL + Exa**。两个仓库通过 HTTP 契约协作，不需要合并源码。

## 启动

要求 Node >=22.13。先按照后端仓库 README 启动 FastAPI（默认 `127.0.0.1:8000`），再运行：

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:3100`。生产构建：

```sh
npm run typecheck
npm run build
npm start
```

`WELLIO_API_BASE_URL` 是服务端代理地址，默认 `http://127.0.0.1:8000`。浏览器仍请求同源 `/api/state`、`/api/actions`、`/api/chat`、`/api/attachments`；Cookie、错误码与 JSON 字段保持一致。后端 `WELLIO_PUBLIC_ORIGIN` 必须包含实际前端来源。密钥和 PostgreSQL URL 配置在后端，不能添加 `VITE_` 前缀。

显式加载前端 `.env`：

```sh
node --env-file=.env ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3100
# 构建后
node --env-file=.env .output/server/index.mjs
```

本机两个仓库并排时可选 `npm run dev:stack` / `npm run start:stack`；要求已配置 `DATABASE_URL`、已安装 `uv`，并存在 `../wellio-backend`，也可设置 `WELLIO_BACKEND_DIR`。它同时启动 FastAPI 和前端，退出时停止本次子进程；PostgreSQL由独立服务提供。

## 当前能力

FastAPI 原生负责会话、训练进度、提案 Apply、撤销、餐食与条件服务、私有附件和 PostgreSQL 持久化。搜索使用 Exa Python SDK。当前阶段没有接通 CopilotKit；`capabilities.agent=false` 和聊天 `503 PROVIDER_NOT_CONFIGURED` 明确表示 Agent 尚不可用。

`src/server` 中除 `api-proxy.ts` 外的旧 TypeScript 领域/Agent 实现保留用于历史行为回归。生产 API 路由只调用 FastAPI 代理，旧 SQLite/Firecrawl 实现不会被这些路由初始化。历史 SDK 单测通过不代表当前 Python Agent 已完成。

共享客户端契约在 `src/lib/contracts.ts`。只有已保存的服务端快照更新记录，Markdown 不作为数据库。默认英文，可在 Profile 切换语言。

## 验证

```sh
npm test                     # UI 与历史 TypeScript 行为回归
npm run typecheck
npm run build
npm run test:e2e              # 需要后端 checkout、uv、本机 PostgreSQL 测试二进制
npm run test:backend:production
```

Playwright 需要 Chromium：`npx playwright install chromium`，或设置 `PLAYWRIGHT_EXECUTABLE_PATH`。浏览器部分场景通过受控 HTTP 响应验证候选方案和冲突 UI；FastAPI 的真实 PostgreSQL、事务、并发及重启由后端 pytest 与生产烟测验证。

`VITE_WELLIO_PREVIEW=1 npm run dev` 仅用于独立视觉预览，不包含数据库、AI、搜索或图片识别；生产忽略该开关。
