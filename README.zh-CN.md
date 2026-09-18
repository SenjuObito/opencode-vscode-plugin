# OpenCode Buddy

一个将 **opencode** agent 带入完整聊天 GUI 的 VS Code 扩展。开发初衷是已有vs code opencode插件太难用了。在github上搜索到cc-gui开源项目。这是 IntelliJ 插件 [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的全新移植版本：React webview 原样保留，Java 后端用 TypeScript 重写，仅保留 **opencode** provider（已移除 Claude / Codex / Grok / Kimi / PI 分支）。

与原插件为每条消息都生成新的 `opencode run` 进程不同，本扩展维护一个**持久化的 `opencode serve` 守护进程**（通过 `@opencode-ai/sdk`），跨所有标签页和对话复用，由守护进程桥接管理，支持预热、心跳、崩溃重启和会话复用。

## 项目理念

[`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的开发方向是兼容各个 AI 的差异，在插件中提供统一的体验。这与本项目的思路不同——本项目旨在**复用 opencode 的能力，不做二次开发**，专注于为 opencode 提供原生的 GUI 体验。

## 开发工具

本项目主要使用 AI 辅助开发：

- **AI 工具**：OpenCode（主要）、Claude Code、WorkBuddy、Gemini
- **AI 模型**：Deepseek-v4-flash（主要）、Gemini、Deepseek-v4-pro、MiMo V2.5、Ox Alpha、hy4、hy3

目前已购买使用Gemini Pro套餐，Deepseek 成本 120 元人民币。
大家如果觉得好用，希望赞赏可以让我回收成本。

## 功能特性

- **持久化 OpenCode 守护进程** —— 无需为每条消息重新创建进程。基于 `@opencode-ai/sdk` 维护常驻的 `opencode serve`（默认端口 4096，支持通过 `OPENCODE_PORT` 自定义），跨请求保持预热、心跳保活、崩溃自动重启，并通过 `AsyncLocalStorage` 实现请求上下文隔离。
- **完整流式交互界面** —— 支持流式文本生成、实时思考过程与增量展开（Thinking Deltas）、工具调用卡片与实时 Diff 展示。
- **多面板与灵活布局** —— 支持 VS Code 左侧活动栏（Activity Bar）、右侧辅助侧边栏（Secondary Sidebar）以及编辑器分栏标签页（Editor Split）；支持在编辑器标题栏一键唤出。
- **多会话标签页管理** —— 顶部原生多 Tab 会话设计，可在同一窗口内无缝切换、新建与管理多个独立对话。
- **便捷上下文与输入交互**：
  - `@` 快速检索并引用工作区文件或代码片段。
  - 支持图片附件拖拽与剪贴板直接粘贴。
  - 编辑器代码选区、文件路径一键发送至上下文。
  - 支持 OpenCode 原生斜杠命令（`/init`、`/review` 等）与 `!shell` 命令。
  - 支持上下文压缩（Context Compaction）以节省 Token。
- **Agent 模式 / 模型 / 思考深度** —— 支持 Build / Plan 等工作模式快速切换；实时从本地 OpenCode 读取已配置的 Provider 与模型列表；支持按需调整思考深度 / 变体（Variant / Reasoning Depth，如 low/medium/high）。
- **权限审批与交互式问答** —— 细粒度权限审批系统（支持单次允许、始终允许、拒绝），原生集成 OpenCode 交互式提问（AskUserQuestion 弹窗问答）与 Plan 计划确认流程。
- **代码修改管理与一键回滚 (Undo File Changes)** —— 实时追踪 AI 对工作区文件的修改，支持按文件单项撤销或一键全量回滚代码变更。
- **会话历史与时光穿梭 (Rewind / Fork)** —— 本地会话管理支持检索、收藏、重命名与删除；支持时光回溯（Rewind）到历史任意节点重新编辑与生成；支持将对话历史导出为 Markdown。
- **MCP 服务与扩展市场** —— 实时监控 MCP 服务连接状态，内置 MCP 市场支持浏览、一键安装、移除与配置 MCP 服务器。
- **技能系统管理 (Skills)** —— 支持全局（Global）与工作区（Local）技能的自动发现、一键导入、启用/禁用切换，并支持在 VS Code 中直接打开编辑 `SKILL.md`。
- **Token 用量统计与监控** —— 实时追踪每次对话及工具调用的 Token 消耗与统计数据。
- **外观与个性化定制** —— 完美融合 VS Code 亮暗主题；支持独立自定义 Webview 界面字体、代码等宽字体、字体大小；支持自定义聊天背景色、状态栏/标题栏色彩及 Diff 视图明暗主题；支持多语言切换。

## 使用教程

### 1. 打开聊天面板

安装插件后，可以通过以下几种方式打开 OpenCode Buddy：
- 点击 VS Code 左侧活动栏的 **OpenCode 图标**。
- 在编辑器标题栏右上角点击 **OpenCode 图标**。
- 在命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）执行：
  - `打开 OpenCode Buddy 面板（左侧）`
  - `新建 OpenCode Buddy 对话`（在编辑器分栏打开独立标签页，支持多个独立会话并发）

<img src="media/home.png" width="800" alt="聊天主界面">

*截图展示为简体中文界面。*

界面区域一览：

- **顶部会话 Tab**：支持新建、关闭与快速切换多个独立对话会话。
- **右上角操作区**：新建会话、搜索会话、历史记录列表、设置面板。
- **底部控制栏**：
  - `任务 / 子代理 / 编辑` —— 切换输入模式。
  - `Build / Plan` —— 切换工作模式。
  - **模型选择** —— 快速切换当前生效的模型（如 `deepseek-v3`、`claude-3-7-sonnet` 等）。
  - **思考深度 (Variant)** —— 控制思考模型的思考力度（如 `low`、`medium`、`high`）。
- **输入框**：支持 `@文件名` 检索引用文件、图片拖拽粘贴、`/bash 命令`、`/opencode 命令`，按 `Enter` 发送（`Shift+Enter` 换行）。

### 2. 个性化设置

点击聊天界面右上角的齿轮图标打开设置面板：

<img src="media/settings.png" width="350" alt="设置页面">

**基础配置 → 外观** 主要选项：

| 项 | 说明 |
|---|---|
| 界面主题 | 跟随 VS Code / 亮色 / 暗色 |
| 界面语言 | 跟随 VS Code / 简体中文 / 英文 |
| 字体大小 / UI 字体 / 代码字体 | 自定义 Webview 内文字字号与字体族 |
| Diff 主题 | 控制 Diff 代码对比视图的明暗主题 |
| 聊天背景色 / 标题栏与状态栏颜色 | 自定义聊天区域色彩方案（支持自定义十六进制颜色） |

设置页顶部还提供 `外观 / 行为 / 环境 / MCP / 技能` 等功能标签，方便全面定制 Agent 行为、MCP 扩展与技能配置。

## 环境要求

- **opencode CLI** 已安装并加入 `PATH`（设置 → Providers → CLI 可查看安装状态；插件不会自动安装二进制文件）。
- 可用的 Node.js 运行时 — 扩展宿主通过 `process.execPath`（Electron-as-node）生成守护进程。

## 开发指南

包管理器为 **pnpm**。仓库包含三个部分，各有独立依赖：

| 部分 | 作用 | 安装 | 构建 |
|---|---|---|---|
| `src/` | 扩展宿主（Java 后端的 TS 重写） | `pnpm install`（仓库根目录） | `pnpm run compile` |
| `webview/` | React 19 + Vite + Tailwind + antd UI（cc-gui 移植） | `cd webview && pnpm install` | `cd webview && pnpm run build` |
| `ai-bridge/` | 持久化守护进程：`opencode serve` + `@opencode-ai/sdk` | `cd ai-bridge && pnpm install` | ESM 直接运行，无需打包 |

webview 构建输出单文件 bundle 到 `dist/webview/index.html`；扩展宿主 bundle 为 `dist/extension.js`（CJS）。在 VS Code 中按 **F5** 启动扩展开发宿主。

### 命令（扩展宿主）

| 任务 | 命令 |
|---|---|
| 类型检查 | `pnpm run check-types`（`tsc --noEmit`） |
| 代码检查 | `pnpm run lint`（`eslint src`） |
| 构建（开发） | `pnpm run compile`（check-types → lint → esbuild） |
| 构建（生产） | `pnpm run package`（压缩） |
| 监听模式（开发） | `pnpm run watch` |
| 运行测试 | `pnpm test`（通过 vscode-test 对真实 VS Code 实例测试） |

### 命令（webview）

| 任务 | 命令 |
|---|---|
| 构建 | `cd webview && pnpm run build`（tsc → vite build，输出单文件 bundle） |
| 单元测试 | `cd webview && pnpm test`（vitest） |
| E2E 测试 | `cd webview && pnpm test:e2e`（Playwright） |

## 架构设计

```
webview/ (React SPA)  ⇄  src/ extension host (TS)  ⇄  ai-bridge/daemon.js (Node ESM)
                            │                              └─ @opencode-ai/sdk ─ opencode serve (持久化)
                            ├─ src/host/router/*        — "type:content" 通信协议
                            ├─ src/host/handlers/*      — 每个消息类型一个处理器（含权限处理）
                            ├─ src/host/session/*       — OpenCodeSession、标记解析器/合并器
                            ├─ src/host/provider/*      — OpenCodeDaemonBridge（NDJSON + 心跳）
                            ├─ src/host/tabs/*          — 多标签页面板（TabManager）
                            ├─ src/host/settings/*      — SettingsService + TabStateService（workspaceState）
                            ├─ src/host/services/*      — McpConfigService、SkillService 等
                            ├─ src/host/context/*       — EditorContextTracker
                            ├─ src/host/notifications/* — NotificationService
                            └─ src/host/fonts/*         — SystemFontEnumerator
```

- webview 通过 `sendToJava("type:content")` 与宿主通信；宿主通过 `postMessage({ type: fn, args })` 调用 `window[fn](...args)` 回复。所有 webview 面板（左侧栏、右侧栏、编辑器分栏）共享同一个 `BroadcastChannel`。
- `ai-bridge/daemon.js` 通过 stdio 传输 NDJSON：`{id, method, params}` 请求、`{id, line}` 流式输出、`{type:'daemon', event}` 生命周期事件。宿主请求为非阻塞。并发请求使用 `AsyncLocalStorage` 进行上下文隔离。
- 扩展宿主（`src/host/`）镜像 cc-gui 的 Java 模块布局：`router/`、`handlers/`、`session/`、`provider/`、`settings/`、`tabs/`、`util/`、`services/`、`context/`、`notifications/`、`fonts/`。

## 赞赏

如果使用体验不错，欢迎赞赏支持：

| 微信 | 支付宝 | PayPal |
|:---:|:---:|:---:|
| <img src="webview/src/assets/images/wallet.png" width="200" alt="微信赞赏码"> | <img src="webview/src/assets/images/wallet-alipay.png" width="200" alt="支付宝赞赏码"> | <img src="webview/src/assets/images/wallet-paypal.png" width="200" alt="PayPal"> |

## 致谢

感谢源项目 [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)，欢迎大家前往源项目点 Star 和赞赏支持。

## 赞助支持

如果这个项目对你有帮助，欢迎赞助支持~

[查看赞助者列表 →](SPONSORS.md)

