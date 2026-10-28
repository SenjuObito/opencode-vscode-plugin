# OpenCode IDEA GUI 多会话能力同步迁移进度

> 配套方案：[`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md)（v2.1）
> 更新规则：每完成一个阶段或功能域，更新本文件；方案的目标态描述不在本文件重复。
> 最后更新：2026-10-28（P8-A18：斜杠命令列表按 tab + 未知命令回退普通消息）

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
| 10.2 | 插件图标与品牌 | ✅ | 市场图标换成 idea 的 512 Aero 标记（`media/opencode.png`）；活动栏/侧边栏/命令图标 `opencode-activity{,-dark,-light}.svg` 按 Aero 几何重画（24 viewBox、单色、evenodd 三段：外框−内腔+内核；暗色 #FFF、亮色 #424242）；`WebviewPanel.iconPath` 沿用按主题二选一；webview 移植 `components/shared/AeroOpenCodeLogo`（玻璃徽章 + 全息内核），`ProviderModelIcon` 的 opencode `colored` 分支改用它，欢迎页/空态因此与 idea 同一套标记。**顺带修**：`WelcomeScreen` 原来用内联 style 写死 `color:#555`，把 `welcome.less` 的主题色整条屏蔽了，现改为 `.welcome-screen` / `.welcome-logo-container` / `.welcome-text-container` 三个类 |
| 10.3 | 新会话默认背景 | ✅ | 空态底纹挂在 `.messages-shell.is-empty-state`（径向极光 + 20px 点阵，含 light 变体），由 `ChatScreen` 按 `!sessionLoading && mergedMessages.length===0` 计算。**偏离方案**：方案写的是 `.chat-screen-shell`，本仓没有该壳层，改挂消息容器以避免污染历史/设置页 |
| 10.4 | 模式列表 | ✅ | `ModeSelect` 改订阅 `store/agentStore`（`useAgents`/`selectPrimaryAgents`/`requestAgents`），只在内置 build/plan 上兜底；`utils/modeColors.ts` 已引入（含 idea 的 6 项测试），输入框描边改 `--mode-accent`，自定义 agent 的 `color` 由宿主 `AgentHandler` 透传；`agents.list` 命令已注册 |
| 10.5 | 模型列表与置顶 | ✅ | **已移植 idea 的 `ModelSelect`**（762 行，含长按 180ms 触发的置顶拖拽排序：Dock 风格浮动卡片、原位占位槽、`translateY` 让位、落位写回 `writePinnedModelIds` → 宿主 `set_pinned_models`）；配套的 `styles/selectors.css` 拖拽样式（`.model-option-pinned-item` / `.model-option-slot` / `.model-option-lifted` / `.is-reordering`）一并移植；测试整份移植 idea 的 `ModelSelect.test.tsx`（14 项，含 5 项拖拽用例）。**保留本仓差异**：下拉定位仍用 `useDropdownPosition`（未移植 idea 的 portal 定位）、新 tab 默认首选置顶 |
| 10.6 | 推理力度 | ✅ | **已与 idea 对齐**：`components/ChatInputBox/reasoningUtils.ts` 直接采用 idea 实现（隐藏时把值复位为 `default`、回落顺序=当前值→第一档）；`types.getAvailableReasoningLevels` 也换成 idea 版本（此前是简化版：忽略 `selectedModel`、`modelVariants` 为空时回落到全部档位 → 选择器**永远不会隐藏**，且把只在目录里出现的 `none` 当默认档）；新增 `isKnownNonReasoningModel`。测试：`types.test.ts`（**整份移植 idea，13 项**）+ `reasoningUtils.test.ts`（4 项） |
| 10.7 | 权限弹窗 | ✅ | 归属由 `SessionCallbackAdapter` 盖章（`PermissionRequest.tabId/sessionId`），`PermissionHandler` 不再靠活跃会话猜；`PromptRegistry` 已接线（`ChatInstance.attachPromptRegistry`），关 tab 时 `rejectForTab` → `rejectPrompts` 真的发 `replyPermission: deny` / `rejectQuestion`；弹窗载荷带 `tabId`。webview 侧改为 **idea 的机制**：请求直接挂在那个 tab 的记录上（`pendingPermissions/pendingQuestions/pendingPlans`），认不到归属 tab 时**当场弹出而不是丢弃**（丢弃＝服务端永远等一个没人能答的 prompt）；切 tab 由 `useTabLifecycle` → `window.__dialogStore.restore(...)` 接管（此前 `__dialogStore` 没人赋值，那条路径一直是死的，本轮在 `useDialogManagement` 里挂上，与 idea 同款）；宿主关闭请求时用 `updateAllTabs` 摘掉所有 tab 上的残留，角标才不会一直亮 |
| 10.8 | 问题弹窗 | ✅ | 与 10.7 同一套：提问弹窗载荷带 `tabId/sessionId`，未决项登记到 tab，关 tab 时 `rejectQuestion`；答复后 `PromptRegistry.forget` 防止重复拒绝。**已补**：dialog 的 `onTimeout` 已接上（超时＝拒绝 + 按 `sessionId` **中断发起请求的会话** + 关闭卡片，`permission.timedOut` 已进 10 个语言包）；答案卡失效时 `invalidateQuestionCard` 会先 `removeQuestionAnswerByRequestId`（与 idea 同款）。测试：移植 idea 的 `useDialogManagement.forceClose.test.ts`（16 项）+ 新增 `permissionRouting`（6 项） |
| 10.9 | 状态面板三子页 | ✅ | `task` 事件带会话归属：宿主 `SessionCallbackAdapter.onTaskEvent` 写入 `sessionId`，webview `isTaskEventForSession` 过滤别的 tab（此前依赖 idea 的 Java 侧过滤，本仓没有）；`todos` 本来按 `sessionID` 过滤。 子页已入 tab：`StatusPanel` 支持受控 `activeTab/onActiveTabChange`，`useTabBarState.statusPanelTab` 按 tab 记，`App → ChatScreen → StatusPanel` 已串通（切 tab 各自恢复展开与子页），有 2 项新测试。`resolveSubagentRunState` 已成为唯一状态推导（`useSubagents` 与 `AgentGroupBlock` 都委托它）。`files.undo` / `files.undo.all` 已事件化（宿主 `HandlerContext.setEventPublisher` → `ChatWindow.publishTabEvent` 按 tab 投递语义事件，请求带 tabId；webview 注册 `files.undo` 处理器） |
| 10.10 | 添加附件 | ✅ | 宿主 `attachments/TabAttachmentStore` + `window/TabAttachmentCommandHandler`：`attachment.prepare/chunk/complete/abort` 全部接上，按 `<globalStorage>/attachments/<tabId>/` 落盘、32MB 上限、分块顺序校验、id/文件名防穿越；`session.send` 只带 `attachmentId`，发送时宿主读回内联字节；关 tab 调 `releaseTab`。切 tab 恢复已补：新增 `usePerTabAttachments` —— 附件草稿按 tab 存（`tab.pendingAttachments`），切 tab 时旧 tab 存回、新 tab 取回；同一 tab 内换会话仍清空（附件属于旧会话）。取代了原来「会话一变就清空附件」的 `useResetAttachmentsOnSessionChange`（已删）。字节仍由宿主 `TabAttachmentStore` 按 tab 落盘，前端只存引用，不写 localStorage。**待人工验收**：10MB 图片不卡、粘贴/拖拽/选择三入口一致 |
| 10.11 | 引用文件 `@` | ✅ | `useFileTags.restoreFileTags` 已移植并接到 imperative handle / 选择控制器（切 tab 回填草稿时不再退化成纯文本），有单测。**已补**：`files.listed` 事件化 —— 新增 tab 命令 `files.list`（宿主 `TabFileCommandHandler`：按**目标 tab 的 cwd** 列举，结果作为 `files.listed` 语义事件回到该 tab，`requestId` 原样带回）；webview `fileReferenceProvider` 改发 `files.list`（带 tab 身份，无活跃 tab 时退回 legacy `list_files`），并注册 `files.listed` 处理器。测试：宿主 `tabFiles`(2) + 前端 1 项 |
| 10.12 | 文件上下文 | ✅ | `context.refresh` 已注册（`src/host/window/TabContextCommandHandler.ts`），写目标 tab 的 `TabSettings.autoOpenFileEnabled/contextEnabled`。发送时已按 tab 取值：`OpenCodeSession` 接受 `autoOpenFileEnabledResolver`（由 `ChatWindow` 按 tab 记录提供），tab 显式设过就用它的、没设过才回落到全局 `getAutoOpenFileEnabled`；`TabSettings.autoOpenFileEnabled` 因此改成三态（`undefined` = 跟随全局）。`context.updated` 回推 |
| 10.13 | bash `!` | ✅ | `session.send` 的 `!cmd` 分支在 `TabSessionSendHandler`，cwd 取目标 tab（`record.getCwd()`）；`SessionHandler` 的旧路径保留为兜底 |
| 10.14 | opencode `/` | ✅ | **列表按 tab**：宿主 `commands.refresh` 按目标 tab 的 cwd 列命令，结果作为语义事件 `slash.commands` 投回**那个 tab**（命名载荷 `{commands}`，带 envelope.tabId）；webview `slashCommandProvider` 改为按 tab 缓存（`commandsByTab`）+ 按 tab 节流，切到某 tab 直接用它自己的缓存，后台 tab 的列表不会污染当前 tab。**未知命令回退普通消息**：宿主新增 `session/KnownCommands.ts`（移植 idea 的已知命令表），`parseSlashCommand` 只认「内置表 ∪ 服务端公布过的自定义命令」，其余以 `/` 开头的文本（`/Users/...`、`/v2/...`）按普通消息处理 —— 命令不该吃编辑器上下文。分享入口保持隐藏（`SHARE_MENU_ENABLED=false`）。测试：宿主 `slashCommands`(4)，前端 `slashCommandProvider.perTab`(2) |

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
4. ~~**弹窗身份**~~ ✅ 2026-10-28（A7/A14）：归属盖章、关 tab 拒绝、超时（拒绝 + 中断会话）、后台 tab 排队与角标，全部按 idea 实现。
5. **状态面板 per-tab**：✅ 面板展开/子页入 `TabStore`；✅ `task` 事件按会话过滤；✅ `files.undo` 事件化。`todos` 事件也按 tab 路由了（`onTodoUpdated` 按 `sessionID` 反查归属 tab：后台 tab 的待办写进那个 tab 的记录，不再被丢弃；字段名/状态按 idea 的规则归一）。
6. ~~**选择器接线**~~ ✅ 2026-10-28（A5/A14/A15）：`ModeSelect` → `agentStore` + `modeColors`；`ReasoningSelect` → guard（与 idea 实现一致）；`ModelSelect` → 置顶拖拽排序（整份移植 idea）。
7. ~~**视觉与品牌**~~ ✅ 2026-10-28（A6/A13）：boot splash、空态底纹、Aero 图标与 `media` 资源。
8. **`@` 与上下文**：✅ `restoreFileTags`、✅ `files.listed` 事件化（按 tab cwd 列举）。`autoOpenFileEnabled` **本仓没有对应行为**（它是 IDEA 侧「编辑后自动打开文件」的功能；本仓只有开关 UI 与 per-tab 存储，没有消费方），因此不存在「注入发送载荷」这一步 —— 不是隔离缺口，是功能缺位。
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
| 2026-10-28 | **P8-A18**：§10.14 斜杠命令 —— 列表按 tab（宿主 `slash.commands` 语义事件按 tab 投递 + webview 按 tab 缓存与节流）；未知命令回退普通消息（移植 idea 的 `KnownCommands`，自定义命令以服务端公布名单为准）；顺带修 **legacy 副本**问题：事件路由器会同时投递 v2 批次与 legacy 回调，前端据此区分「某个 tab 的事件的副本」（忽略）与「窗口级回放」（采纳）。测试：宿主 `slashCommands`(4)，前端 `slashCommandProvider.perTab`(2)；**修 `scripts/run-tests.mjs` 的写死分组**（新增测试文件此前根本没进全量运行） |
| 2026-10-28 | **P8-A17**：§10.12 `autoOpenFileEnabled` 真正按 tab 生效 —— `OpenCodeSession` 新增 `autoOpenFileEnabledResolver`（`ChatWindow` 按 tab 记录提供），`TabSettings.autoOpenFileEnabled` 改三态（未设置=跟随全局项目设置）。测试 `tabAutoOpenFile`(1) |
| 2026-10-28 | **P8-A16**：`todos` 事件按 tab 路由（`onTodoUpdated` 按 sessionID 反查归属 tab，后台 tab 的待办写进该 tab 而非丢弃；字段名/状态归一同 idea）；附件草稿按 tab 保存（`usePerTabAttachments` + `tab.pendingAttachments`，切 tab 各自保留、同 tab 换会话才清空，取代旧的 `useResetAttachmentsOnSessionChange`）。测试：前端 `todoRouting`(4) + `usePerTabAttachments`(3) |
| 2026-10-28 | **P8-A15**：§10.5 整份移植 idea 的 `ModelSelect.tsx` + `styles/selectors.css`（长按 180ms 触发置顶拖拽排序，落位写回 `writePinnedModelIds`），测试移植 idea 的 `ModelSelect.test.tsx`(14)；§10.11 `files.listed` 事件化（新增 tab 命令 `files.list` + `TabFileCommandHandler`，按目标 tab 的 cwd 列举，结果按 tab 回到请求方，`requestId` 带回）；§10.9 `files.undo` / `files.undo.all` 事件化（`HandlerContext.setEventPublisher` → `ChatWindow.publishTabEvent`）。测试：宿主 `tabFiles`(2)，前端 `ModelSelect`(14) 与 `fileReferenceProvider`(+1) |
| 2026-10-28 | **P8-A14**：三处「自己写 ≠ idea 实现」的偏差改回合规实现 —— ①`reasoningUtils.ts` + `types.getAvailableReasoningLevels` 直接采用 idea 版本（此前选择器永远不会隐藏、隐藏时不复位值）；②后台 tab 的弹窗请求改挂到 tab 记录上（`pendingPermissions/pendingQuestions/pendingPlans`），认不到 tab 就当场弹，`__dialogStore` 在 `useDialogManagement` 里挂上（此前 `useTabLifecycle` 的 restore 调用是死代码）；③弹窗超时＝拒绝 + 中断会话 + 关卡片（`permission.timedOut` × 10 语言包），答案卡失效时摘 store。测试：移植 idea `types.test.ts`(13) 与 `useDialogManagement.forceClose.test.ts`(16)，新增 `reasoningUtils.test.ts`(4) 与 `permissionRouting.test.ts`(6) |
| 2026-10-28 | **P8-A13**：§10.2 图标与品牌——`media/opencode.png` 取 idea 512 图标；`opencode-activity*.svg` 按 pluginIcon 几何重画为单色版；移植 `AeroOpenCodeLogo` 并接到 `ProviderModelIcon` 的 opencode 彩色分支；`WelcomeScreen` 去掉写死的 `#555` 内联色。测试 `ProviderModelIcon` 补 2 项（彩色走徽章、单色走 lobehub） |
| 2026-10-28 | **P8-A12**：`utils/pendingPromptQueue`（按 tab 入队/出队/宿主关闭时摘除）+ `permissionCallbacks` 路由（非活跃 tab 不弹窗）+ `App` 切 tab 冲刷；角标沿用 tab 的 `pendingPermissions/pendingQuestions`。测试 4 项 |
| 2026-10-28 | **P8-A11**：移植 `resolveSubagentRunState`（`utils/subagentResult`），`useSubagents.determineStatus` 与 `AgentGroupBlock` 都改为委托；transcript 只能作为终态事件的替代；新增 4 项测试 |
| 2026-10-28 | **P8-A10**：`task` 事件的会话归属（宿主打标 + webview `isTaskEventForSession` 过滤），测试补 1 项宿主 + 3 项前端 |
| 2026-10-28 | **P8-A9**：`save_json` 接通（legacy handler + 窗口级 v2 命令，`ExportHandler.saveText` 保存对话框）；§2.3 命令面缺口只剩 `files.listed` |
| 2026-10-28 | **P8-A8**：`StatusPanel` 子页受控化（`activeTab/onActiveTabChange`），接到 `useTabBarState.statusPanelTab`（按 tab 存），App/ChatScreen 透传；新增 2 项测试（受控上报、切 tab 各自恢复） |
| 2026-10-28 | **P8-A7**：`SessionCallbackAdapter` 给权限/提问请求盖 `tabId+sessionId`；`PermissionHandler` 接入 `PromptRegistry`（登记归属、答复后 `forget`）；关 tab 时 `rejectPrompts` 对未决项发 `replyPermission: deny` / `rejectQuestion` 并关卡片。测试 `tabPrompts`（7 项） |
| 2026-10-28 | **P8-A6**：`index.html` 内联首帧底色 + `#boot-splash`（`main.tsx` 首帧后移除）；`useFileTags.restoreFileTags` 移植并串到 imperative handle（新增 1 项测试，`useFileTags` 共 12 项通过）；§10.3 空态底纹（`.messages-shell.is-empty-state` + light 变体） |
| 2026-10-28 | **P8-A5**：附件链路（`TabAttachmentStore` 按 tab 落盘、分块顺序校验、32MB 上限、发送按 id 解内联、关 tab 释放）、`session.load`、`settings.mode`、`agents.list`；`ModeSelect` 改订阅 `agentStore`、移植 `modeColors` + `--mode-accent`、`ReasoningSelect` 接 `useReasoningEffortGuard`。测试 `tabAttachments`（9 项）、`ModeSelect`（4 项）、`modeColors`（6 项，来自 idea） |
| 2026-10-28 | **P8-A3**：webview 发送 / 中断 / 新会话改走 v2 命令（`session.send` / `session.interrupt` / `session.new`），删除 `create_new_session` 全部 8 处与协议常量，宿主移除对应 legacy handler；新增 `useMessageSender.tabSend` 测试 |
