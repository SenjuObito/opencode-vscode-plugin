# OpenCode IDEA GUI 多会话能力同步迁移进度

本文档用于实时跟踪与记录依据 [`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md) 将 `opencode-idea-gui`（v0.3.0）多会话标签页与单实例多视图架构移植至 `opencode-vscode-plugin` 的迁移进度。

---

## 1. 总体进度仪表盘

| 阶段 | 模块 | 核心交付物 | 状态 | 验证结果 |
|---|---|---|---|---|
| **P0 基线** | 协议与护栏 | 协议/ID冻结、`src/host/tab` 骨架、grep 护栏、EventCatalog 一致性测试 | ✅ 已完成 (`b28fcc9`) | 单测通过，无单会话遗留命令泄漏 |
| **P1 Core + 引擎** | 依赖与引擎 | pin `v1.0.0`、L0 env、`engine_status`、`daemon.status.engine` | ✅ 已完成 (`e8ef19b`) | core 单测全绿，三态环境检测就绪 |
| **P2 宿主 Tab 内核** | Tab 模型与路由 | `TabId` / `TabRegistry` / `TabSessionActor` / `TabStreamRouter` / `PendingSend` | ✅ 已完成 (`9258cfd`) | 跨 Tab 并发互不干扰，单测 22 项通过 |
| **P3 宿主单实例多视图** | 多视图协同 | `ChatWindow` / `ViewRegistry` / `PromptRegistry` / `TabEventRouter` | 🟡 核心完成，宿主装配中 (`a45b128`) | 单测通过；待接入 `OpenCodeViewProvider` |
| **P4 协议 v2** | 出入站协议 | `HostCommand` / LRU 去重 / `command.rejected` / batch 批处理通道 | ✅ 已完成 (`a45b128`) | 5 大拒绝码校验通过，双向映射就绪 |
| **P5 Webview A 类引入** | 架构文件引入 | 30 个架构文件、8 个 Tab 状态 Store、useSessionTabs、44 项新单测 | ✅ 已完成 (`32f022a`) | 69 文件 / 833 单测 100% 绿灯 |
| **P6 Webview B 类合并** | 重分叉文件合并 | `ChatHeader.tsx`、`header.less`、`App.tsx` 接入 `useSessionTabs`、类型对齐 | ✅ 已完成 (`528c2de`) | `tsc --noEmit` 0 error，全量构建打包成功 |
| **P7 多会话 UI 校验** | 标签栏交互 | 标签栏切换、新建、关闭、重命名、拖拽排序、右键菜单、溢出折叠 | 🔄 进行中 | 待多视图宿主装配后 E2E 验证 |
| **P8 功能矩阵回归** | 功能 Tab 隔离 | fork / revert / compact / 权限弹窗定点 / 附件分块 / 状态面板隔离 | ⏳ 待开始 | 遵循“只影响目标 tab”原则 |
| **P9 性能与发布验证** | 健壮性与包验证 | resync 重建、reload 恢复、core pin 依赖检查、干净打包 | ⏳ 待开始 | CI / GitHub Release 验收 |

---

## 2. 关键阶段实施细节

### P0 ~ P2：基线与宿主 Tab 内核 (Commit: `b28fcc9`, `e8ef19b`, `9258cfd`)
- 宿主完成 `src/host/tab/` 实体层：`TabId`、`SessionId`、`TurnId`、`TabRegistry`、`TabRecord`、`TabSessionActor`、`TabStreamRouter`、`PendingSend`。
- Core 依赖固定为 `v1.0.0`，实现 `engine_status` 与 L0 环境变量注入。
- 建立架构护栏测试，杜绝在 `src/host/tab` 中出现单会话遗留命令。

### P3 ~ P4：单实例多视图与协议 v2 (Commit: `a45b128`)
- 实现 `ChatWindow` 单实例顶层聚合：
  - `ViewRegistry`：维护 VS Code 左侧边栏、右侧边栏、编辑器 Panel 等各视图，精确计算 `promptHostId`。
  - `TabEventRouter`：提供 fair-weight batching 与 lane 优先级分流。
  - `PromptRegistry`：权限申请与提问弹窗唯一定向。
  - `HostCommand`：协议 v2 出入站校验与 LRU 2048 `requestId` 去重，非法调用回传标准 `command.rejected`。
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

---

## 3. 当前最新测试矩阵状态

| 测试套件 | 测试文件数 | 用例总数 | 通过数 | 失败数 |
|---|---|---|---|---|
| **Webview 单元测试 (Vitest)** | 69 | 833 | 833 | 0 |
| **Webview TypeScript 类型检查** | - | - | 0 error | 0 |
| **宿主单元测试 (Mocha)** | 5 | 22 | 22 | 0 |
| **宿主 TypeScript / ESLint** | - | - | 0 error | 0 |

---

## 4. 下一步行动计划 (P3 装配与 P7 UI 联动)

1. **宿主层装配**：
   - 在 `src/extension.ts` 中初始化唯一的 `ChatWindow` 单例。
   - 改造 `src/host/webview/OpenCodeViewProvider.ts`，接收 `ChatWindow`，将 webview 注册为该窗口的 View，消息直接流转至 `chatWindow.handleViewCommand`。
   - 改造 `src/host/tabs/TabManager.ts`（原生编辑器 Panel），同样作为 `ChatWindow` 的 View 注册，实现侧边栏与编辑器 Panel 共享同一 Tab 集合。
2. **P7 多标签页交互验证**：
   - 验证 Tab 新建、切换、关闭（关自身/关其他/关左侧/关右侧/全部关闭）。
   - 验证双视图实时同步（左侧边栏切 Tab，右侧/编辑器面板同时响应）。
   - 验证右键菜单与重命名。
3. **P8 & P9 验收推进**。
