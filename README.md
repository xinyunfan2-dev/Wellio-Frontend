# Wellio frontend

React / TanStack Start 前端，通过 CopilotKit React SDK 连接内置 Agent。独立[后端仓库](https://github.com/xinyunfan2-dev/Wellio-Backend)提供 CopilotKit Node Runtime、FastAPI、PostgreSQL 和 Exa。模型采用 OpenRouter 的 `deepseek/deepseek-v4.1-flash`。

## 启动

先按照后端 README 启动 PostgreSQL、FastAPI（默认 8000）和 Node Agent（默认 8001），再运行：

```sh
cd wellio-app
npm ci
npm run dev
```

打开 `http://127.0.0.1:3100`。完整配置和测试说明见[应用 README](wellio-app/README.md)。本地统一启动可设置 `WELLIO_BACKEND_DIR` 为后端绝对路径，使用 `npm run dev:stack`。目标是 macOS Apple Silicon 本地演示；无需 CopilotKit 云账号，模型和搜索仍使用外部 API。

## 协作

页面和 API/Agent 分仓协作，以同源 HTTP 契约连接。旧 TypeScript 业务服务、SQLite、旧模型和搜索执行器及失效测试已移除。当前前端 99 项测试与类型检查通过；Agent 全链路受控验证记录在后端交付文档，真实 OpenRouter 和 Exa 调用仍需凭据联调。

修改使用独立分支与 PR，保留队友提交。不要上传密钥、`.env`、数据库、用户附件或依赖目录。
