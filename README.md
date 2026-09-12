# Wellio frontend

React / TanStack Start 前端，后端独立位于 [Wellio-Backend](https://github.com/xinyunfan2-dev/Wellio-Backend)。当前业务链路使用 FastAPI + PostgreSQL，搜索服务为 Exa；CopilotKit 属于下一阶段。

## 启动

先按照后端仓库 README 启动 FastAPI（默认 `127.0.0.1:8000`），再启动前端：

```sh
cd wellio-app
npm ci
npm run dev
```

打开 `http://127.0.0.1:3100`。`WELLIO_API_BASE_URL` 仅服务端读取，浏览器保持同源 `/api/*`。后端 `WELLIO_PUBLIC_ORIGIN` 应包含实际前端来源。完整配置、功能边界和测试说明见 [应用 README](wellio-app/README.md)。

## 验证与协作

本阶段 419 项前端/历史行为回归、34 项浏览器测试、类型检查与构建通过，原生 FastAPI/PG 的独立验证在后端仓库。旧 TypeScript 服务只供历史行为回归，生产 API 已代理到 FastAPI。聊天暂时明确不可用，未把旧 SDK 测试算作 CopilotKit 完成。

两个仓库并排 checkout 时，集成测试可以设置 `WELLIO_BACKEND_DIR` 为后端绝对路径；不把后端源码上传到本仓库。Python/PG 测试工具和启动要求见后端说明。

后续修改使用独立分支与 PR，不覆盖队友提交。不要上传密钥、`.env`、数据库、用户附件或依赖目录。
