# OpenCode IDEA GUI 多会话能力同步迁移进度

本文档用于实时跟踪与记录依据 [`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md) 将 `opencode-idea-gui`（v0.3.0）多会话标签页与单实例多视图架构移植至 `opencode-vscode-plugin` 的迁移进度。

---

## 1. 总体进度仪表盘

| 阶段 | 模块 | 核心交付物 | 状态 | 验证结果 |
|---|---|---|---|---|
| **P0 基线** | 协议与护栏 | 协议/ID冻结、`src/host/tab` 骨架、grep 护栏、EventCatalog 一致性测试 | ✅ 已完成 (`b28fcc9`) | 单测通过，无单会话遗留命令泄漏 |
| **P1 Core + 引擎** | 依赖与引擎 | pin `v1.0.0`、L0 env、`engine_status`、`daemon.status.engine` | ✅ 已完成 (`e8ef19b`) | core 单测全绿，三态环境检测就绪 |
| **P2 宿主 Tab 内核** | Tab 模型与路由 | `TabId` / `TabRegistry` / `TabSessionActor` / `TabStreamRouter` / `PendingSend` | ✅ 已完成 (`9258cfd`) | 跨 Tab 并发互不干扰，单测 22 项通过 |
| **P3 宿主单实例多视图** | 多视图协同 | `ChatWindow` / `ViewRegistry` / `PromptRegistry` / `TabEventRouter` / 宿主装配 | ✅ 已完成 (`da64da2`) | 左右栏与编辑器 Panel 共享唯一 TabRegistry，全视图实时同步 |
| **P4 协议 v2** | 出入站协议 | `HostCommand` / LRU 去重 / `command.rejected` / batch 批处理通道 | ✅ 已完成 (`a45b128`) | 5 大拒绝码校验通过，双向映射就绪 |
| **P5 Webview A 类引入** | 架构文件引入 | 30 个架构文件、8 个 Tab 状态 Store、useSessionTabs、44 项新单测 | ✅ 已完成 (`32f022a`) | 69 文件 / 833 单测 100% 绿灯 |
| **P6 Webview B 类合并** | 重分叉文件合并 | `ChatHeader.tsx`、`header.less`、`App.tsx` 接入 `useSessionTabs`、类型对齐 | ✅ 已完成 (`528c2de`) | `tsc --noEmit` 0 error，全量构建打包成功 |
| **P7 多会话 UI 校验** | 标签栏交互 | 标签栏切换/新建/关闭/拖拽、右键菜单、溢出菜单、i18n 多语言对齐 | ✅ 已完成 (`1ad2079`) | 菜单禁用与分享隐藏符合 D8，全语言 key 齐备 |
| **P8 功能矩阵回归** | 功能 Tab 隔离 | fork / revert / compact / 权限弹窗定点 / 附件分块 / 状态面板隔离 | ✅ 已完成 (`f2c6ecb`) | 遵循“只影响目标 tab”原则，各 Tab 状态严格隔离 |
| **P9 性能与发布验证** | 健壮性与包验证 | 全量双端编译通过、core pin 依赖检查、纯净依赖与无脏代码打包 | ✅ 已完成 (`clean`) | 依赖 `v1.0.0`，无本地软链接，全流水线 100% 绿灯 |

---

## 2. 关键阶段实施细节

### P0 ~ P2：基线与宿主 Tab 内核 (Commit: `b28fcc9`, `e8ef19b`, `9258cfd`)
- 宿主完成 `src/host/tab/` 实体层：`TabId`、`SessionId`、`TurnId`、`TabRegistry`、`TabRecord`、`TabSessionActor`、`TabStreamRouter`、`PendingSend`。
- Core 依赖固定为 `v1.0.0`，实现 `engine_status` 与 L0 环境变量注入。
- 建立架构护栏测试，杜绝在 `src/host/tab` 中出现单会话遗留命令。

### P3 ~ P4：单实例多视图与协议 v2 (Commit: `a45b128`, `da64da2`)
- 实现 `ChatWindow` 单实例顶层聚合：
  - `ViewRegistry`：维护 VS Code 左侧边栏、右侧边栏、编辑器 Panel 等各视图，精确计算 `promptHostId`。
  - `TabEventRouter`：提供 fair-weight batching 与 lane 优先级分流。
  - `PromptRegistry`：权限申请与提问弹窗唯一定向。
  - `HostCommand`：协议 v2 出入站校验与 LRU 2048 `requestId` 去重，非法调用回传标准 `command.rejected`。
- **宿主顶层装配落盘 (`da64da2`)**：
  - `src/extension.ts`：初始化全局唯一的 `chatWindow` 单例。
  - `src/host/webview/OpenCodeViewProvider.ts`：左/右侧边栏均注入 `chatWindow`，注册视图与可见性监听，统一由 `chatWindow.handleViewCommand` 处理 `host_command`，并触发 `resyncView`。
  - `src/host/tabs/TabManager.ts`：编辑器原生 Tab Panel 打开时注册为 `chatWindow` 视图，生命周期和消息通道无缝接入同一会话核心。
- 宿主 22 项单测全绿。

### P5：Webview A 类架构文件完整引入 (Commit: `32f022a`)
- 完整引入 30 个架构与 Store 文件至 `webview/src/`：
  - `store/`：`tabStore.ts`, `tabMessageStore.ts`, `tabDraftStore.ts`, `tabPromptStore.ts`, `tabTransitionStore.ts`, `tabRuntime.ts`, `agentStore.ts`, `questionAnswerStore.ts`, `tabStatusStore.ts`。
  - `hooks/sessionTabs/`：`types.ts`, `useTabBarState.ts`, `useTabLifecycle.ts`, `useTabSessionBinder.ts`。
  - `hooks/`：`useSessionTabs.ts`, `useStreamingMessages.ts`（改造为 per-tab runtime map 架构）。
  - `components/ChatHeader/`：`SessionTabBar.tsx`, `SessionTabContextMenu.tsx`, `types.ts`。
  - `utils/`：`hostDispatcher.ts`, `hostEventRegistry.ts`, `hostEventTypes.ts`, `semanticEvents.ts`, `sessionIdentity.ts`, `tabPartition.ts`, `attachmentTransport.ts`, `revertStateEvent.ts`, `sessionTitle.ts`, `messageMergeCache.ts`。
  - `hooks/windowCallbacks/`：`sequenceBarrier.ts`, `tabTransition.ts`, `resetTransientState.ts`。
- 补充 44 项 Tab 状态管理单元测试，全部通过。

### P6：Webview B 类合并与类型全面对齐 (Commit: `528c2de`)
- **`ChatHeader.tsx`**：完成替换，集成 `<SessionTabBar />`，支持标签切换、新建、右键菜单、重命名等。
- **`header.less`**：同步标签栏完整样式、CSS 变量、过渡动画与折叠溢出样式。
- **`App.tsx`**：
  - 接入 `useSessionTabs` 协调器，解构 Tab 控制逻辑并透传至 `ChatHeader`。
  - 修复 `useMessages()` 与 `useUIState()` 中的 getter 解构（`status`, `loadingStartTime`, `isThinking`, `sessionLoading`, `compactingStartTime`, `contextInfo`）。
  - 修复 `autoOpenFileEnabled` 多标签隔离 fallback。
  - 补齐 `HistoryView` 的 `onConvertToCliSession` 契约。
- **构建与测试验证**：
  - `cd webview && pnpm test`：**69 个测试文件，833 项单元测试 100% 全部通过**。
  - `cd webview && pnpm run build`：生产打包通过，单文件 `dist/webview/index.html` 自动同步完成。
  - 宿主构建 `pnpm run compile`：0 error 绿灯。

### P7：多会话 UI 与交互对齐 (Commit: `1ad2079`)
- 按照 §7 规范全面补齐中英文 i18n key：`common.newSession`、`common.pendingApproval`、`common.moreSessions`、`chat.renameSession`、`chat.forkSession`、`chat.exportMarkdown`、`chat.closeOtherTabs`、`chat.closeTabsToRight`、`chat.closeTabsToLeft`、`chat.closeAllTabs`、`chat.tabBusy`、`chat.tabWaiting`、`chat.sendFailedNoTab`。
- `SessionTabContextMenu.tsx` 中 `SHARE_MENU_ENABLED = false` 保持分享入口隐藏（符合 D8 决策）。
- 菜单项文案统一使用 i18n 标准文案（如“重命名”、“导出为 Markdown”）。
- 全量构建与全部 833 项单元测试维持 100% 绿灯。

### P8 & P9：功能矩阵隔离回归与终验 (Clean / All Passed)
- 验证各项命令（fork / revert / compact / interrupt / 拖拽重排等）均严格携带 `tabId` 与匹配的 `sessionId`，杜绝跨 Tab 串扰。
- 权限申请与提问弹窗唯一定向至活跃视图 `promptHostId`。
- 依赖包纯净性核对：`package.json` 指向 `"opencode-buddy-core": "github:SenjuObito/opencode-buddy-core#v1.0.0"`，无本地 link 残留。
- 全量全端统一编译验证：`pnpm run compile && cd webview && pnpm run build` 耗时约 25s 顺利通过，产物自动生成至 `dist/`。

---

## 3. 最终测试与编译矩阵

| 验证项 | 指标要求 | 实测结果 | 结论 |
|---|---|---|---|
| **Webview 单元测试 (Vitest)** | 全部原有用例 + 44 项多会话新用例通过 | 69 个测试文件，833 项单测 100% 通过 | ✅ 绿灯 |
| **Webview 类型检查 (tsc)** | 无编译与类型错误 | 0 error | ✅ 绿灯 |
| **Webview 单文件打包** | 打包为单文件 index.html 并同步根目录 | `dist/webview/index.html` 9.7MB 成功生成 | ✅ 绿灯 |
| **宿主单元测试 (Mocha)** | 包含多视图与 Tab 内核的所有关键单测 | 5 个测试套件，22 项单测 100% 通过 | ✅ 绿灯 |
| **宿主代码检查与编译** | TypeScript + ESLint + esbuild 打包 | 0 error / 0 warning，产物输出正常 | ✅ 绿灯 |
