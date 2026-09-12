# 协作说明

## 分支

从最新 `main` 建自己的功能分支，修改后提 PR。页面、后端和共享接口的改动尽量分开，避免多人同时改同一文件。

```sh
git switch main
git pull --ff-only
git switch -c feat/your-feature
```

PR 写清楚问题、最终行为与检查结果。UI 改动附中英文截图，并检查较矮手机尺寸；不要通过隐藏内容解决溢出。

## 接口边界

当前前端使用同源请求：

| 入口 | 用途 |
| --- | --- |
| `GET /api/state` | 读取共享状态 |
| `POST /api/actions` | 显式业务操作与保存回执 |
| `/api/copilotkit/*` | CopilotKit SDK 对话、停止与提案生成 |
| `POST /api/attachments` | 上传图片 |
| `GET /api/attachments/:attachmentId` | 读取会话图片 |

请求、快照和事件以 `wellio-app/src/lib/contracts.ts` 为准，保留 camelCase 字段、会话 cookie、版本与操作去重语义。Python 的内部命名不应直接改变前端契约。

`src/server` 仅负责 FastAPI 与 CopilotKit 同源代理。领域逻辑与 Node Agent 在独立后端仓库维护，不在前端实现第二套业务或 Agent。接口变更同步代理、契约和回归测试。

Today 与 Agent 共用方案和状态。候选方案必须经明确确认才应用；休息确认不开始训练。模型未配置、失败或断开时显示真实状态，不填充伪造结果。

## 页面核验

- 正常和低恢复默认概览：390×844、375×812、390×790、390×740。
- 小屏及展开内容：320×640，详情应可滚动到达，没有横向溢出。
- 保留 Wellio 02 / B 的现有视觉和中英文切换，不因后端迁移重新设计页面。

## 提交范围

`.env.example` 只保留空配置或示例。不要提交 `.env`、真实凭据、数据库文件、上传目录、测试运行产物或 `node_modules`。
