# OpenCode IDEA GUI 多会话能力同步迁移进度

> 配套方案：[`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md)（v2.1）
> 更新规则：每完成一个阶段或功能域，更新本文件；方案的目标态描述不在本文件重复。
> 最后更新：2026-10-28（P8-A4：补齐 `context.refresh` / `commands.refresh` 接收端，并补 §2.3 命令面缺口清单）

---

## 0. 结论

- **架构主干（P0–P7）已落地**：宿主 Tab 内核、单实例多视图、协议 v2、webview 的 30 个架构文件、标签栏 UI 与 i18n 均已在代码中。
- **功能域（P8）尚未完成**：宿主 handler 仍有 **21 处** `getSession()`（单会话语义），权限仍借会话，附件/上下文/命令刷新链路缺失；webview 侧的模式、模型、推理、弹窗、状态面板、附件、`@`、空态背景等仍是旧实现。
- 本文上一版把 P8/P9 标为"已完成"，**与代码不符**，本版已更正。后续以本文件与 §2 的核查结果为准。

---

## 1. 阶段仪表盘

| 阶段 | 内容 | 状态 | 证据 / 说明 |
|---|---|---|---|
| **P0** | 协议/ID 冻结、`src/host/tab` 骨架、grep 护栏、EventCatalog 测试 | ✅ | `b28fcc9` |
| **P1** | core pin `v1.0.0`、L0 env、`engine_status`、`daemon.status.engine` | ✅ | `e8ef19b` |
| **P2** | `TabRegistry` / `TabRecord` / `TabSessionActor` / `TabStreamRouter` / `PendingSend` | ✅ | `9258cfd` |
| **P3** | `ChatWindow` / `ViewRegistry` / `PromptRegistry` / 单实例装配 | ✅ | `da64da2` |
| **P4** | `HostCommand` / LRU 去重 / `command.rejected` / batch | ✅ | `a45b128` |
| **P5** | webview 30 个架构文件 + store + `useSessionTabs` | ✅ | `32f022a` |
| **P6** | `ChatHeader` / `header.less` / `App.tsx` 接入标签栏 | ✅ | `528c2de` |
| **P7** | 标签栏交互、右键菜单、share 隐藏、i18n | ✅ | `1ad2079`（`SHARE_MENU_ENABLED=false` 已核） |
| **P8** | 14 项功能域隔离与回归 | 🟡 | 见 §2：8 项部分完成，6 项未开始 |
| **P9** | 全量终验、性能、发布包验证 | ⬜ | 依赖 P8；本版未复跑全量测试 |

> 图例：✅ 完成 / 🟡 部分完成 / ⬜ 未开始 / ⛔ 阻塞

---

## 2. 功能域核查（对应方案 §10）

| # | 功能域 | 状态 | 代码证据 / 缺口 |
|---|---|---|---|
| 10.1 | 启动页与首帧 | ⬜ | 无 `boot-splash`；`webview/index.html` 无内联底色（注释仍写"由 Java 注入"，已失效） |
| 10.2 | 插件图标与品牌 | ⬜ | `media/*` 未更新；webview 无 `AeroOpenCodeLogo`（idea 独有，尚未引入） |
| 10.3 | 新会话默认背景 | ⬜ | `welcome.less` 无 `.chat-screen-shell` / `.is-empty-state`；`ChatScreen` 无空态 class |
| 10.4 | 模式列表 | 🟡 | `store/agentStore.ts` 已引入，但 `ModeSelect` 仍用 `providers/agentProvider`；`modeColors.ts` 缺失 |
| 10.5 | 模型列表与置顶 | ⬜ | `ModelSelect` 无置顶拖拽排序/portal；仍为旧版点击置顶 |
| 10.6 | 推理力度 | 🟡 | `reasoningUtils.ts` 已存在，但 `useReasoningEffortGuard` 未被 `ReasoningSelect` 使用 |
| 10.7 | 权限弹窗 | 🟡 | `prompt/PromptRegistry.ts` 已建；`PermissionHandler.ts:78` 仍 `?? context.getSession()`；dialog 无 `tabId` |
| 10.8 | 问题弹窗 | 🟡 | `store/questionAnswerStore.ts` 已引入，但 dialog 无 `tabId/sessionId/onTimeout`，答案卡未接 store 事件 |
| 10.9 | 状态面板三子页 | ⬜ | `StatusPanel` 仍用组件本地 `openPopover`；undo 走 `window.onUndoFileResult`；`useSubagents` 未统一 `resolveSubagentRunState` |
| 10.10 | 添加附件 | 🟡 | `utils/attachmentTransport.ts` 已引入但未被发送路径使用；宿主 `AttachmentHandler` 缺失 |
| 10.11 | 引用文件 `@` | ⬜ | 无 `useFileTags.restoreFileTags`；`files.listed` 事件未接 |
| 10.12 | 文件上下文 | 🟡（宿主已接） | `context.refresh` 已注册（`src/host/window/TabContextCommandHandler.ts`），写目标 tab 的 `TabSettings.autoOpenFileEnabled/contextEnabled`。**仍缺**：发送时按 tab 注入（`OpenCodeSession.send` 仍读全局 `getAutoOpenFileEnabled`）、`context.updated` 回推 |
| 10.13 | bash `!` | 🟡 | `SessionHandler` 仍 `context.getSession()`：只对"当前会话"生效 |
| 10.14 | opencode `/` | 🟡（宿主已接） | `commands.refresh` 已注册，按目标 tab 的 cwd 列命令（`{directory}`）并回推 `updateSlashCommands`；webview 不再发旧名 `refresh_slash_commands`（`slashCommandProvider` / `main.tsx` 已改）。**仍缺**：列表仍是窗口级单例（回推用广播）、内置命令本地执行与 per-tab 缓存 |

### 2.1 宿主单会话遗留（P8 的前置）

`src/host` 仍有 **21 处** `context.getSession()`，分布在：

`handlers/{WindowEvent,Session,Context,History,ModelProvider,Export,Permission,CliModels,Settings}Handler.ts`

典型后果：
- `SessionHandler` 的 `send` / `interrupt` / `!shell` 只作用于当前会话；
- `PermissionHandler` 的弹窗归属可能错；
- `ModelProviderHandler` 的模型/推理力度写入当前会话；
- `HistoryHandler` 切换历史会话仍走 `switchToSession` 语义。

### 2.2 缺失的宿主能力

| 能力 | 现状 |
|---|---|
| `context.refresh` | ✅ 已注册（`TabContextCommandHandler.refreshContext`） |
| `commands.refresh` | ✅ 已注册（按目标 tab 的 cwd 列命令） |
| `AttachmentHandler` | 不存在（`attachment.prepare/chunk/complete/abort` 无接收方） |
| `PromptRegistry` 接线 | 类已存在，`PermissionHandler` 未使用 |
| `TabSessionCommandHandler` | 存在，但 share 分组需保持休眠 |

### 2.3 命令面缺口（webview 已发 / 宿主无接收方）

`ChatWindow.handleViewCommand` 对未注册命令一律回 `command.rejected: UNKNOWN_TYPE`。
按 webview 的发送点清点，当前仍未注册的命令：

| 命令 | webview 发送点 | 后果 |
|---|---|---|
| `session.send` | 未切（仍发旧 `send_message`） | A2/A3 目标 |
| `session.interrupt` | `useTabLifecycle.ts:260`（`sendInterrupt`） | 关 tab 时中断不到目标会话 |
| `session.load` | `useTabSessionBinder.ts:677` | 切历史会话无宿主响应 |
| `settings.mode` | `useTabSessionBinder.ts:212` | per-tab 模式不落宿主 |
| `attachment.prepare/chunk/complete` | `utils/attachmentTransport.ts` | 附件链路断 |
| `agents.list` | `store/agentStore.ts:104` | agent 列表只能靠旧推送 |
| `save_json` | `utils/exportMarkdown.ts:383/432` | 导出保存无响应 |

---

## 3. 已完成的架构主干（摘要）

| 模块 | 落点 |
|---|---|
| 宿主 Tab 内核 | `src/host/tab/*`（16 文件） |
| 单窗口/多视图 | `src/host/window/{ChatWindow,ViewRegistry,TabEventRouter,TabSessionCommandHandler}.ts` |
| 协议 v2 | `src/host/router/HostCommand.ts` + `OpenCodeViewProvider` 的 `host_command` 入口 |
| webview 架构层 | `store/*`（8 文件）、`hooks/sessionTabs/*`、`hooks/useSessionTabs.ts`、`components/ChatHeader/{SessionTabBar,SessionTabContextMenu,types}`、`utils/{hostDispatcher,hostEventRegistry,hostEventTypes,semanticEvents,sessionIdentity,tabPartition,attachmentTransport,revertStateEvent,sessionTitle}`、`hooks/windowCallbacks/{sequenceBarrier,tabTransition,resetTransientState}` |
| 标签栏 UI | `ChatHeader.tsx` + `SessionTabBar.tsx` + `header.less`（40 处 session-tab 样式） |
| 分享隐藏 | `SessionTabContextMenu.tsx` `SHARE_MENU_ENABLED=false` |
| i18n | `common.pendingApproval`、`chat.tabBusy`、`chat.sendFailedNoTab` 等已补齐 |

> 以上为"骨架就位"，不代表功能已按 tab 隔离；隔离验收见 §2。

---

## 4. 下一步（按依赖排序）

1. **宿主去单会话**：`SessionHandler`、`PermissionHandler`、`ContextHandler`、`ModelProviderHandler`、`HistoryHandler`、`ExportHandler`、`SettingsHandler`、`CliModelsHandler`、`WindowEventHandler` 全部改为 `getSessionForTab(tabId)` / `getSession(sessionId)`。
   - 前置条件（2026-10-28 核查新增）：`TabSessionFactory` / `TabStreamRouter` **尚未接线**，`TabRecord.getSession()` 恒为 null，且 `ChatInstance` 是 per-view 装配。必须先接线会话归属，否则无处解析。
2. ~~**补宿主命令**：`context.refresh`、`commands.refresh`；`slashCommandProvider` 改为发 `commands.refresh`。~~ ✅ 2026-10-28 完成
3. **附件链路**：`AttachmentHandler` + `globalStorageUri/attachments/<tabId>` + 发送只带 id。
4. **弹窗身份**：`PermissionDialog` / `AskUserQuestionDialog` 接 `tabId/sessionId/requestId/onTimeout`；`PromptRegistry` 接入 `PermissionHandler`。
5. **状态面板 per-tab**：面板展开/子页入 `TabStore`；`todos/task/subagent` 按 tab；`files.undo` 事件化。
6. **选择器接线**：`ModeSelect` → `agentStore` + `modeColors`；`ModelSelect` 置顶拖拽；`ReasoningSelect` → guard。
7. **视觉与品牌**：boot splash、空态背景、Aero 图标与 `media` 资源。
8. **`@` 与上下文**：`restoreFileTags`、`files.listed`、per-tab `contextEnabled` 注入。
9. **P9 终验**：见 §5。

---

## 5. 验收门

- `cd ../opencode-buddy-core && npm test`
- `pnpm run compile`
- `cd webview && pnpm test && pnpm run build`
- 端到端：2 视图 + 3 tab + 2 并发流；关视图再开；关最后一个 tab；daemon 重启；v1/v2 各一遍
- 日志/静态检查：`unattributed=0`；`getSession()` 在 handler 中归零；无 `create_new_session` / `switch_session` / `refresh_slash_commands`
- 打包：`pnpm run unlink:core` → `pnpm run package`，产物使用 `v1.0.0`

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-28 | 建立文档；记录 P0–P7 架构主干落地 |
| 2026-10-28 | **更正**：P8/P9 此前误标完成；补 14 项功能域核查（对应方案 §10），列出 21 处 `getSession()` 与缺失的宿主命令 |
| 2026-10-28 | **P8-A4**：新增 `util/SlashCommandCatalog.ts`（命令列举单一实现）与 `window/TabContextCommandHandler.ts`；`ChatWindow` 注册 `context.refresh` / `commands.refresh`；移除 `WindowEventHandler` 的 `refresh_slash_commands`；webview 改发 `commands.refresh`。补 §2.3 命令面缺口清单与 A1 前置条件 |
