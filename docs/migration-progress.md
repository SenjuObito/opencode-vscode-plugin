# OpenCode IDEA GUI 多会话能力同步迁移进度

> 配套方案：[`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md)（v2.1）
> 更新规则：每完成一个阶段或功能域，更新本文件；方案的目标态描述不在本文件重复。
> 最后更新：2026-10-28（P8-A12：后台 tab 的 prompt 排队 + 角标）

---

## 0. 结论

- **架构主干（P0–P7）已落地**：宿主 Tab 内核、单实例多视图、协议 v2、webview 的 30 个架构文件、标签栏 UI 与 i18n 均已在代码中。
- **2026-10-28 起 P8 有了实质进展**：
  - **会话归属已接线**（A1/A2）：`ChatWindow` 持有 `TabSessionFactory`，每个 tab 有自己的 `OpenCodeSession`；`session.send` / `session.interrupt` / `session.new` 按 `tabId` 路由；切 tab 回放宿主快照。此前 `TabSessionFactory` 无实例化点、`ChatInstance` 是 per-view，`TabRecord.getSession()` 恒为 null。
  - **webview 发送路径已切换**（A3）：`send_message` → `session.send`，`create_new_session` → `session.new`，`interrupt_session` 带 tabId（无身份时才退回窗口级）。
  - **两条断链命令已补**（A4）：`context.refresh` / `commands.refresh`。
- **仍然未完成**：剩余 handler 的 `getSession()` 语义（21 处仍在，但已随 resolver 指向活跃 tab 的会话）、附件分块链路、弹窗身份、状态面板 per-tab、`@` 与上下文注入、P9 终验。
- 本文此前把 P8/P9 标为"已完成"曾与代码不符，2026-10-28 已做两轮更正；**本文以代码核查为准**。

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
| **P8** | 14 项功能域隔离与回归 | 🟡 | 见 §2：会话归属与发送/中断已按 tab 路由；余下见 §2.3 / §4 |
| **P9** | 全量终验、性能、发布包验证 | ⬜ | 依赖 P8；本版未复跑全量测试 |

> 图例：✅ 完成 / 🟡 部分完成 / ⬜ 未开始 / ⛔ 阻塞

---

## 2. 功能域核查（对应方案 §10）

| # | 功能域 | 状态 | 代码证据 / 缺口 |
|---|---|---|---|
| 10.1 | 启动页与首帧 | ✅ | `index.html` 内联 `html,body,#app` 底色（跟随 `--vscode-sideBar-background`，不写死颜色）+ `#boot-splash`（SVG 标记、`prefers-reduced-motion` 下不动画）；`main.tsx` 在首帧提交后（双 rAF）移除。加载失败仍由 `ErrorBoundary` 兜底 |
| 10.2 | 插件图标与品牌 | ⬜ | `media/*` 未更新；webview 无 `AeroOpenCodeLogo`（idea 独有，尚未引入） |
| 10.3 | 新会话默认背景 | ✅ | 空态底纹挂在 `.messages-shell.is-empty-state`（径向极光 + 20px 点阵，含 light 变体），由 `ChatScreen` 按 `!sessionLoading && mergedMessages.length===0` 计算。**偏离方案**：方案写的是 `.chat-screen-shell`，本仓没有该壳层，改挂消息容器以避免污染历史/设置页 |
| 10.4 | 模式列表 | ✅ | `ModeSelect` 改订阅 `store/agentStore`（`useAgents`/`selectPrimaryAgents`/`requestAgents`），只在内置 build/plan 上兜底；`utils/modeColors.ts` 已引入（含 idea 的 6 项测试），输入框描边改 `--mode-accent`，自定义 agent 的 `color` 由宿主 `AgentHandler` 透传；`agents.list` 命令已注册 |
| 10.5 | 模型列表与置顶 | ⬜ | `ModelSelect` 无置顶拖拽排序/portal；仍为旧版点击置顶 |
| 10.6 | 推理力度 | ✅ | `reasoningUtils.useReasoningEffortGuard` 成为唯一实现（档位来源 `types.getAvailableReasoningLevels`、可见性=无档位即隐藏、回落=推荐档→第一档）；`ReasoningSelect` 的内联副本已删除 |
| 10.7 | 权限弹窗 | 🟡（归属已修） | 归属由 `SessionCallbackAdapter` 盖章（`PermissionRequest.tabId/sessionId`），`PermissionHandler` 不再靠活跃会话猜；`PromptRegistry` 已接线（`ChatInstance.attachPromptRegistry`），关 tab 时 `rejectForTab` → `rejectPrompts` 真的发 `replyPermission: deny` / `rejectQuestion`；弹窗载荷带 `tabId`。webview 侧已排队：`pendingPromptQueue` 按 tab 缓存后台请求、切过去才弹、宿主关闭时摘除；tab 栏的「等待操作」角标按 `pendingPermissions/pendingQuestions` 点亮 |
| 10.8 | 问题弹窗 | 🟡（归属已修） | 与 10.7 同一套：提问弹窗载荷带 `tabId/sessionId`，未决项登记到 tab，关 tab 时 `rejectQuestion`；答复后 `PromptRegistry.forget` 防止重复拒绝。**仍缺**：dialog 的 `onTimeout` 与答案卡接 `questionAnswerStore` |
| 10.9 | 状态面板三子页 | 🟡（tab 归属已通） | `task` 事件带会话归属：宿主 `SessionCallbackAdapter.onTaskEvent` 写入 `sessionId`，webview `isTaskEventForSession` 过滤别的 tab（此前依赖 idea 的 Java 侧过滤，本仓没有）；`todos` 本来按 `sessionID` 过滤。 子页已入 tab：`StatusPanel` 支持受控 `activeTab/onActiveTabChange`，`useTabBarState.statusPanelTab` 按 tab 记，`App → ChatScreen → StatusPanel` 已串通（切 tab 各自恢复展开与子页），有 2 项新测试。`resolveSubagentRunState` 已成为唯一状态推导（`useSubagents` 与 `AgentGroupBlock` 都委托它）。**仍缺**：`files.undo` 事件化 |
| 10.10 | 添加附件 | 🟡（链路已通） | 宿主 `attachments/TabAttachmentStore` + `window/TabAttachmentCommandHandler`：`attachment.prepare/chunk/complete/abort` 全部接上，按 `<globalStorage>/attachments/<tabId>/` 落盘、32MB 上限、分块顺序校验、id/文件名防穿越；`session.send` 只带 `attachmentId`，发送时宿主读回内联字节；关 tab 调 `releaseTab`。**仍缺**：切 tab 恢复未发送的附件草稿（`TabAttachmentStore` 未接草稿） |
| 10.11 | 引用文件 `@` | 🟡 | `useFileTags.restoreFileTags` 已移植并接到 imperative handle / 选择控制器（切 tab 回填草稿时不再退化成纯文本），有单测。**仍缺**：`files.listed` 语义事件未接（仍走 legacy `list_files` → `onFileListResult`） |
| 10.12 | 文件上下文 | 🟡（宿主已接） | `context.refresh` 已注册（`src/host/window/TabContextCommandHandler.ts`），写目标 tab 的 `TabSettings.autoOpenFileEnabled/contextEnabled`。**仍缺**：发送时按 tab 注入（`OpenCodeSession.send` 仍读全局 `getAutoOpenFileEnabled`）、`context.updated` 回推 |
| 10.13 | bash `!` | ✅ | `session.send` 的 `!cmd` 分支在 `TabSessionSendHandler`，cwd 取目标 tab（`record.getCwd()`）；`SessionHandler` 的旧路径保留为兜底 |
| 10.14 | opencode `/` | 🟡（宿主已接） | `commands.refresh` 已注册，按目标 tab 的 cwd 列命令（`{directory}`）并回推 `updateSlashCommands`；webview 不再发旧名 `refresh_slash_commands`（`slashCommandProvider` / `main.tsx` 已改）。**仍缺**：列表仍是窗口级单例（回推用广播）、内置命令本地执行与 per-tab 缓存 |

### 2.1 宿主单会话遗留（P8 的前置）——已处理

`src/host` 仍有 **21 处** `context.getSession()`，分布在：
`handlers/{WindowEvent,Session,Context,History,ModelProvider,Export,Permission,CliModels,Settings}Handler.ts`

**2026-10-28 状态**：这 21 处**不再是单会话 bug** —— `SessionManager` 已注入
session resolver（`ChatWindow.bindSessionManager`），`getSession()` 解析到**活跃 tab 自己的会话**。
仍然成立的两条限制：

- 它们是「活跃 tab」语义，不是「目标 tab」语义。真正需要定向的操作（发送 / 中断 / 新会话 /
  历史切换）已走 `tabId` 命令；其余（设置、模型、导出、权限）目前按活跃 tab 解释是正确的，
  但等附件/弹窗按 tab 归属后需要逐个复核。
- `HistoryHandler` 的 `switchToSession` 现在委托 `ChatWindow.replaceActiveTabSession`，
  在**活跃 tab 内**换绑而不是销毁共享实例。

### 2.2 缺失的宿主能力

| 能力 | 现状 |
|---|---|
| `context.refresh` | ✅ 已注册（`TabContextCommandHandler.refreshContext`） |
| `commands.refresh` | ✅ 已注册（按目标 tab 的 cwd 列命令） |
| `AttachmentHandler` | ✅ 已注册（`TabAttachmentStore` + `TabAttachmentCommandHandler`） |
| `PromptRegistry` 接线 | 类已存在，`PermissionHandler` 未使用 |
| `TabSessionCommandHandler` | 存在，但 share 分组需保持休眠 |

### 2.3 命令面缺口（webview 已发 / 宿主无接收方）

`ChatWindow.handleViewCommand` 对未注册命令一律回 `command.rejected: UNKNOWN_TYPE`。
按 webview 的发送点清点，当前仍未注册的命令：

| 命令 | webview 发送点 | 后果 |
|---|---|---|
| `session.send` | ✅ 已切（`useMessageSender` → `sendHostCommand(tabId,'session.send')`） | A2/A3 完成 |
| `session.interrupt` | ✅ 已切（`sendInterrupt`，无 tab 身份时退回 legacy `interrupt_session`） | 关 tab 时只中断目标 |
| `session.new` | ✅ 已切（`sendNewSession`，替代 `create_new_session`） | 在活跃 tab 内重置会话 |
| `session.load` | ✅ 已接（`ChatWindow` → `switchActiveTabSession` + `HistoryHandler.loadSessionById`） | 历史会话装进目标 tab |
| `settings.mode` | ✅ 已接（写 TabSettings + 目标会话状态） | per-tab 模式落宿主 |
| `attachment.prepare/chunk/complete` | ✅ 已接（`utils/attachmentTransport.ts` → `TabAttachmentStore`） | 分块落盘，发送只带 id |
| `agents.list` | ✅ 已接（`ChatWindow` → `AgentHandler.refresh`） | 首次打开即可拉取目录 |
| `save_json` | ✅ 已接（窗口级：`ChatWindow` 在 tab 路由前处理 → `ExportHandler.saveText`，带保存对话框与「打开文件」） | 导出/下载可用 |

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

1. ~~**宿主去单会话**~~ ✅ 2026-10-28（A1/A2）：会话归 tab、`context.getSession()` 解析活跃 tab、发送/中断/新会话按 tabId 路由。
2. ~~**补宿主命令**：`context.refresh`、`commands.refresh`；`slashCommandProvider` 改为发 `commands.refresh`。~~ ✅ 2026-10-28 完成
3. ~~**附件链路**~~ ✅ 2026-10-28（A5）：`TabAttachmentStore` + 命令 handler + 发送按 id 解析。**仍缺**：未发送附件草稿的切 tab 恢复。
4. **弹窗身份**：`PermissionDialog` / `AskUserQuestionDialog` 接 `tabId/sessionId/requestId/onTimeout`；`PromptRegistry` 接入 `PermissionHandler`。
5. **状态面板 per-tab**：面板展开/子页入 `TabStore`；`todos/task/subagent` 按 tab；`files.undo` 事件化。
6. **选择器接线**：✅ `ModeSelect` → `agentStore` + `modeColors`；✅ `ReasoningSelect` → guard。**仍缺**：`ModelSelect` 置顶拖拽排序。
7. **视觉与品牌**：boot splash、空态背景、Aero 图标与 `media` 资源。
8. **`@` 与上下文**：`restoreFileTags`、`files.listed`、per-tab `autoOpenFileEnabled` 注入（宿主开关已落地，`OpenCodeSession.send` 仍在读全局设置）。
9. ~~**`session.load`**~~ ✅ 2026-10-28（A5）。
10. **P9 终验**：见 §5。

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
| 2026-10-28 | **P8-A1/A2**：`ChatWindow` 接线 `TabSessionFactory`（每 tab 一个会话）+ `TabScopedSink` 投影 + 切 tab 快照回放；`SessionManager` 注入 resolver/lookup/replacer；`ChatInstance` 合并为全窗口单例（`BroadcastWebviewChannel`）；新增 `session.send` / `session.interrupt` / `session.new` 命令。测试 `tabSessionOwnership`（7 项） |
| 2026-10-28 | **P8-A12**：`utils/pendingPromptQueue`（按 tab 入队/出队/宿主关闭时摘除）+ `permissionCallbacks` 路由（非活跃 tab 不弹窗）+ `App` 切 tab 冲刷；角标沿用 tab 的 `pendingPermissions/pendingQuestions`。测试 4 项 |
| 2026-10-28 | **P8-A11**：移植 `resolveSubagentRunState`（`utils/subagentResult`），`useSubagents.determineStatus` 与 `AgentGroupBlock` 都改为委托；transcript 只能作为终态事件的替代；新增 4 项测试 |
| 2026-10-28 | **P8-A10**：`task` 事件的会话归属（宿主打标 + webview `isTaskEventForSession` 过滤），测试补 1 项宿主 + 3 项前端 |
| 2026-10-28 | **P8-A9**：`save_json` 接通（legacy handler + 窗口级 v2 命令，`ExportHandler.saveText` 保存对话框）；§2.3 命令面缺口只剩 `files.listed` |
| 2026-10-28 | **P8-A8**：`StatusPanel` 子页受控化（`activeTab/onActiveTabChange`），接到 `useTabBarState.statusPanelTab`（按 tab 存），App/ChatScreen 透传；新增 2 项测试（受控上报、切 tab 各自恢复） |
| 2026-10-28 | **P8-A7**：`SessionCallbackAdapter` 给权限/提问请求盖 `tabId+sessionId`；`PermissionHandler` 接入 `PromptRegistry`（登记归属、答复后 `forget`）；关 tab 时 `rejectPrompts` 对未决项发 `replyPermission: deny` / `rejectQuestion` 并关卡片。测试 `tabPrompts`（7 项） |
| 2026-10-28 | **P8-A6**：`index.html` 内联首帧底色 + `#boot-splash`（`main.tsx` 首帧后移除）；`useFileTags.restoreFileTags` 移植并串到 imperative handle（新增 1 项测试，`useFileTags` 共 12 项通过）；§10.3 空态底纹（`.messages-shell.is-empty-state` + light 变体） |
| 2026-10-28 | **P8-A5**：附件链路（`TabAttachmentStore` 按 tab 落盘、分块顺序校验、32MB 上限、发送按 id 解内联、关 tab 释放）、`session.load`、`settings.mode`、`agents.list`；`ModeSelect` 改订阅 `agentStore`、移植 `modeColors` + `--mode-accent`、`ReasoningSelect` 接 `useReasoningEffortGuard`。测试 `tabAttachments`（9 项）、`ModeSelect`（4 项）、`modeColors`（6 项，来自 idea） |
| 2026-10-28 | **P8-A3**：webview 发送 / 中断 / 新会话改走 v2 命令（`session.send` / `session.interrupt` / `session.new`），删除 `create_new_session` 全部 8 处与协议常量，宿主移除对应 legacy handler；新增 `useMessageSender.tabSend` 测试 |
