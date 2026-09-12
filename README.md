# Wellio

健身与饮食 Agent 应用。当前仓库提供可运行的 **TanStack Start / React 前端协作基线**，采用 Wellio 02 视觉、B 图标包与牛油果角色，支持中英文。

## 启动

需要 Node.js **22.13 或更高版本**（本次验证使用 22.15）和 npm。

```sh
git clone https://github.com/xinyunfan2-dev/Wellio.git
cd Wellio/wellio-app
npm ci
npm run dev
```

打开 http://127.0.0.1:3100/today 。首次访问根路径进入 Agent。

## 当前包含什么

- Today：准备度、睡眠、完整训练动作、直接开始或确认调整、营养和饮食。默认概览已适配常见手机尺寸。
- Agent：对话气泡、Markdown、图片输入、工具调用状态与显式确认。
- Trends：体重、按器械区分的训练重量与睡眠。
- Profile：语言、用户条件与演示场景设置。
- Workout：全屏训练、动作动画与进度记录。
- 已选用的图标、角色和动画文件，安装后即可显示，无需另外获取设计工作区。

## 前后端协作边界

**FastAPI 业务后端正在独立迁移；CopilotKit / Python Agent 属于后续阶段。此次提交不表示迁移已经完成。**

为了让队友拉取后就能运行，`wellio-app/src/server` 暂时保留已验证的 Node / SQLite 兼容实现。前端通过 HTTP 与它通信；迁移完成后可替换服务实现，保持 `src/lib/contracts.ts` 中的数据约定。不要在页面中直接依赖数据库或将 AI 返回的文字当成保存结果。

模型配置默认留空。语言和已有训练进度等本地业务可以运行；真正的 AI 建议、识图和餐厅搜索需要服务端配置，当前不会自动生成或填入假回复。历史数据是演示种子，首次访问会建立独立本地会话。

| 目录 | 用途 |
| --- | --- |
| `wellio-app/src/features` | 页面和页面样式 |
| `wellio-app/src/components` | 共享组件、图标、角色 |
| `wellio-app/src/lib` | 数据契约、HTTP 客户端与共享状态 |
| `wellio-app/src/routes` | 页面路由与当前 API 入口 |
| `wellio-app/src/server` | 迁移前的兼容服务实现 |
| `wellio-app/public/assets` | 应用实际使用的视觉资源 |
| `wellio-app/tests` | 单元、接口和浏览器检查 |

后续 Python 服务计划加入仓库的 `wellio-backend/`，当前未提交未完成的迁移文件。

## 检查与协作

```sh
cd wellio-app
npm run typecheck
npm test
npm run build
```

浏览器测试及生产启动见 [应用说明](wellio-app/README.md)。分支与接口协作约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本仓库不包含本地 `.env`、数据库、用户上传图片、已安装依赖、构建产物及历史设计备份。配置示例在 `wellio-app/.env.example`。
