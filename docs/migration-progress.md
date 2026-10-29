# OpenCode IDEA GUI 多会话能力同步迁移进度

> 配套方案：[`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md)（v2.1）
> 更新规则：每完成一个阶段或功能域，更新本文件；方案的目标态描述不在本文件重复。
> 最后更新：2026-10-29（P9-A25：历史深度刷新、生成指示器与若干 UI 对齐；全量编译/测试复跑）
>
> 对比基线：`opencode-idea-gui` HEAD `b27d9bf`（release 0.3.0，方案基线 `4a5b42a` 之后仅 3 个提交：
> 消息背景分级、README、checkstyle），`opencode-vscode-plugin` 分支 `feature/opencode-v2` HEAD `3e166ea`。

---

## 0. 结论（2026-10-29 收口复核）

- **单视图多 tab 已可用**：宿主 Tab 内核（`src/host/tab/*` 16 文件）、per-tab 会话、发送/中断/历史切换、
  附件分块、权限/提问归属、状态面板子页、`@`/`/`/`!`、模型/模式/推理力度均已按 tab 隔离。
- **多视图运行时同步已接线（本轮 A21）**：
  - webview 消费 `tab.created/closed/activated/reordered/draft.changed`、`prompt.host.changed`、
    `view.navigate`；`tab.resync` 保持；
  - webview 发送 `view.ready`、`view.focus`、`view.navigate`、`tab.reorder`、`tab.draft.changed`
    （300ms 防抖，带 `sourceViewId` 回声抑制）；
  - 拖拽排序写入宿主并广播；tab 重命名同步服务端标题（`session.rename`）；
  - 宿主回放 `tab.activated` 延后一拍，保证多视图先切 tab 再收消息快照。
- **G8 数据面已重写（本轮）**：`SessionCallbackAdapter` / `StreamMessageCoalescer` 的会话输出
  全部改为命名 `TabEvent`（`content.delta` / `thinking.delta` / `message.snapshot` /
  `message.tail` / `turn.started` / `turn.ended` / `session.bound` / `session.cleared` /
  `session.loaded` / `tab.state` / `message.error` …），带 `tabId`/`sessionId`/`turnId`/`seq`，
  经 `TabEventRouter` 的 per-tab lane 广播；webview 按 `envelope.tabId` 写入对应 tab 的
  `messageStore` / tab 记录，只有活跃 tab 才触发 React 更新。`TabScopedSink` 的“后台丢弃 +
  切回整段回放”已删除。
- **命令面 v2 对齐（本轮）**：`TabSessionCommandHandler` 的 core 方法名修正为
  `opencode.fork` / `opencode.summarize` / `opencode.shareSession` / `opencode.unshareSession` /
  `opencode.revert` / `opencode.unrevert`，并补齐 fork 目标 tab 绑定、revert 指针回写、
  compact/share 结果事件；webview 的 fork/compact/revert/share/unshare 从 legacy
  `*_session` 切换到 `sendHostCommand` / `sendSessionCommand`，结果走命名事件。
- **验收门已全绿**：
  - `pnpm run compile` ✅（`tsc --noEmit` + `eslint src` + esbuild）；
  - `webview pnpm run build` ✅；
  - webview `vitest` **178 文件 / 1476 项**全绿；`tsc -p tsconfig.test.json --noEmit` ✅；
  - 宿主 `pnpm test`（`pretest` 先清理 `out/`）**119 passing / 0 failing**。
- 整体完成度估算：宿主架构 ≈99%、webview 架构 ≈97%、14 项功能域 **14/14**、多视图一致性 ≈98%。
---

## 1. 阶段仪表盘

| 阶段 | 内容 | 状态 | 证据 / 说明 |
|---|---|---|---|
| **P0** | 协议/ID 冻结、`src/host/tab` 骨架、grep 护栏、EventCatalog 测试 | ✅ | `b28fcc9`；A21 起护栏同时扫 `PermissionHandler` 与 webview `bridge.ts`（G10） |
| **P1** | core pin `v1.0.0`、L0 env、`engine_status`、`daemon.status.engine` | ✅ | core pin 与 `engine_status` 已通；A21 补 §8.3 UI：`StatusNoticeBar` 在 `unknown/blocking` 时出告警条 + 重新检测，`EnvironmentTab` 展示状态/CLI 版本/来源/路径/API 版本/原因（G9） |
| **P2** | `TabRegistry` / `TabRecord` / `TabSessionActor` / `TabStreamRouter` / `PendingSend` | ✅ | 16 个文件齐；G8 后会话数据走命名 `TabEvent` + per-tab lane，`TabScopedSink` 已删除 |
| **P3** | `ChatWindow` / `ViewRegistry` / `PromptRegistry` / 单实例装配 | ✅ | 宿主类与装配完成；A21 接线 `view.ready/focus/navigate`、`tab.*` 广播消费、prompt host 选举定位（G1） |
| **P4** | `HostCommand` / LRU 去重 / `command.rejected` / batch | ✅ | v2 信封、LRU、rejected、`host.events` 批量均完成；缺 tabId 的 tab 级命令直接拒绝（仅 `agents.list`/`commands.refresh`/`session.new` 允许），`PermissionHandler` 不再借用活跃会话，并有 `unattributed` 计数（G11/INV-7）；数据面已命名事件化（G8） |
| **P5** | webview 30 个架构文件 + store + `useSessionTabs` | ✅ | `store/*` 8 个、`hooks/sessionTabs/*` 4 个、`utils/*` 9 个、`windowCallbacks/*` 3 个均在 |
| **P6** | webview B 类合并 | ✅ | 25 个重点文件已合并；删除 `TabStatusStore`，tab 记录成为唯一状态载体（G2）；G8 后数据面按 `envelope.tabId` 路由，legacy `window.<fn>` 仅保留未迁移的窗口级事件 |
| **P7** | 标签栏 UI、菜单、拖拽、快捷键、i18n | ✅ | 标签栏/菜单与 idea 一致；A21 补 `role=tablist/tab`、`aria-selected`、Alt+T/W/1-9/←→、F2/Delete、焦点随 ←→ 移动（G12）；拖拽排序写入宿主并广播（G1） |
| **P8** | 14 项功能域隔离与回归 | ✅ | 14/14；A21 修 `subagent.history` 断链（G3）、补 `contextEnabled` 消费（10.12）、状态面板毛玻璃与子代理详情（10.9） |
| **P9** | 全量终验、性能、发布包验证 | 🟡 | 编译/构建/单测全绿；发布包（`unlink:core` + `pnpm run package`）仍需在无 link 的干净依赖环境复跑 |

> 图例：✅ 完成 / 🟡 部分完成 / ⬜ 未开始 / ⛔ 阻塞

---

## 2. 方案逐章完成度

| 章节 | 目标 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| §3.1 规则 1（`tab.activated` 全视图） | 宿主广播 + 各视图切换 | ✅ | webview `onTabActivated` 以 `fromHost` 模式完整恢复目标 tab（不回声 `tab.activate`）；宿主回放延后一拍 |
| §3.1 规则 2（`tab.created/closed`） | 各视图增删 | ✅ | webview 增删本地 tab、清理草稿/prompt；关闭活跃 tab 时不预选邻居，交给 `tab.activated` 完整恢复 |
| §3.1 规则 3（`tab.reorder`） | 宿主保存顺序并广播 | ✅ | `reorderTabs` 写本地后发 `tab.reorder`；宿主保存并广播 `tab.reordered`，其他视图重排 |
| §3.1 规则 4（`view.ready → tab.resync`） | 视图重建恢复 | ✅ | 视图挂载即发 `view.ready` → 宿主 `resyncView` + 主动推 agent 目录 |
| §3.4 不变式 | INV-1…INV-9 | ✅ | INV-4：tab 级命令缺 tabId 直接拒绝（窗口级白名单）；INV-7：`ChatWindow.unattributedCount`；INV-9：删除 `TabStatusStore`，tab 记录单一写入；其余不变式原实现保留 |
| §4.1 宿主模块 | tab/window/prompt/router | ✅ | 文件齐全；`TabStreamRouter` 存在但 delta 未走它 |
| §4.4 命令路由 | 缺 tab 拒绝、不回落 | ✅ | 仅 `agents.list` / `commands.refresh` / `session.new` 允许无 tabId；其余回 `MISSING_TAB_ID` |
| §4.5 数据面 | 每会话 parser/sink + lane | ✅ | 每会话命名 `TabEvent` + `TabEventRouter` per-tab lane；后台 tab 的事件写入自己的记录/消息库，不再丢弃；delta 在 lane 内按 `turnId` 合并 |
| §4.6 生命周期 | daemon 重启收 `turn.ended{daemon_restart}` | ✅ | `ChatWindow.handleDaemonDied()` 清所有 tab loading/streaming，活跃视图收 `onStreamEnd{reason:daemon_restart}`；`extension.ts` 的 `onDaemonDied` 已接线 |
| §4.8 PromptRegistry | 三类表 + 三重校验 | 🟡 | 三表归属、关 tab 拒绝、`forget` 已完成；**回复只按 `requestId`/`channelId` 查表，未校验 tab/session**，也没有失败回执（`command.rejected`） |
| §4.9 回复定向 | 状态广播、失败回发起视图 | ✅ | `rejectCommand(viewId…)`；会话事件走 `TabEventRouter` + legacy 广播 |
| §5.2 事件分发 | registry 唯一入口、无 window 回退 | 🟡 | 数据面已全部走 `hostDispatcher → registerHostEvents`；窗口级/命令回执仍有 legacy `window[fn]` 回退（未迁移项，不影响 tab 数据路由） |
| §5.4 多视图适配 | 单一写入方、草稿同步、弹窗选举、页面同步 | ✅ | 草稿 300ms 防抖 + `sourceViewId` 回声抑制；`prompt.host.changed` 选举后仅 host 渲染弹窗，落选视图回队；页面切换 `view.navigate` 同步；滚动仍按 tab（各视图独立 UI 状态） |
| §5.5 删除清单 | 6 项 | ✅ | 删除 `skipNewSessionConfirm` 全链路（文件、设置开关、二次确认弹窗、偏好键）、6 个分享死文案、`open_class` 分支与 bridge 函数、legacy `send_message/send_message_with_attachments/interrupt_session` 兜底 |
| §6.1 命令目录 | 真实命令名 | ✅ | 新增 `subagent.history`、`session.rename` handler；`open_class` 已删；其余 66 个发送点全部命中 |
| §6.2 入站信封 | `{v,type,fn,tabId,epoch,…}` + 批量/lane | ✅ | 信封、批量、epoch 拒旧事件；delta/snapshot/生命周期全部走 per-tab lane，`legacy:false` 防止对象载荷被当作位置参数二次投递 |
| §6.3 事件目录 | 140 + 新增 8 项"两端一致" | ✅ | 两端均 148 项；新增 `semanticEvents.parity.test.ts` 直接读宿主 `EventCatalog.ts` 比对键集 |
| §7.1–7.13 标签栏 UI | 布局/尺寸/状态/四档/溢出/右键/重命名/i18n | ✅ | 与 idea 1:1；`SHARE_MENU_ENABLED=false`；13 个 tab i18n key 在 `zh`/`en` 齐全，其余 8 个语言包缺失并回退 `en`（`i18n/config.ts:36`） |
| §7.14 快捷键与无障碍 | Alt+T/W/1-9/←→、F2/Delete、tablist/tab | ✅ | 容器 `role=tablist`，tab 为 `role=tab` + `aria-selected` + roving `tabIndex`；Alt 组合键与 F2/Delete/Enter/←→ 已实现 |
| §7.15 视觉验收 | 10 项 | 🟡 | 拖拽排序已全视图同步；毛玻璃胶囊已移植；仍需人工逐项目测 |
| §8.1/8.2 引擎链路 | env → core → engine_status → payload | ✅ | `extension.ts:69-71` 注入；`DaemonStatusPayload.engine` |
| §8.3 引擎 UI | 告警条 + 环境页展示 + 诊断 | ✅ | `StatusNoticeBar` 在 `unknown/blocking` 时显示原因/CLI 信息 + “重新检测”；`EnvironmentTab` 展示引擎状态、CLI 版本/来源/路径、API 版本与原因 |
| §10 功能域 | 14 项 | ✅ | 14/14（10.9 子代理详情与毛玻璃、10.12 `contextEnabled` 消费均补） |
| §11 文件处置 | A 照搬 / B 合并 / C 不动 / D 删除 | ✅ | A 类 30 个全部落地；D 类残留已清（G6） |

---

### 2.1 宿主 `context.getSession()` 现状（21 处）

`SessionManager` 已注入 session resolver（`ChatWindow.bindSessionManager`），`getSession()` 解析到**活跃 tab 自己的会话**，
因此不再是"单会话 bug"；但它仍是"活跃 tab 语义"而非"目标 tab 语义"：

| 文件 | 次数 | 说明 |
|---|---|---|
| `WindowEventHandler` | 7 | `frontend_ready` 回放、daemon 状态、窗口级命令 |
| `SessionHandler` / `SettingsHandler` | 3 / 3 | legacy 发送兜底、全局设置 |
| `ModelProviderHandler` / `PermissionHandler` | 2 / 2 | 模型查询；权限兜底（`?? getSession()` 违反 §10.7，G11） |
| `CliModelsHandler` / `ContextHandler` / `ExportHandler` / `HistoryHandler` | 各 1 | 按活跃 tab 解释即可 |

真正需要定向的操作（发送 / 中断 / 新会话 / 历史 / 附件 / 弹窗 / `@` / `/`）已走 `tabId`；
剩余调用待多视图改造与 §10.12 时逐个复核。

---

## 3. 功能域核查（对应方案 §10）

| # | 功能域 | 状态 | 代码证据 / 缺口 |
|---|---|---|---|
| 10.1 | 启动页与首帧 | ✅ | `index.html` 内联 `html,body,#app` 底色 + `#boot-splash`（`prefers-reduced-motion`）；`main.tsx` 双 rAF 后移除；`ErrorBoundary` 兜底 |
| 10.2 | 插件图标与品牌 | ✅ | `media/opencode.png`（idea 512）、单色活动栏 `opencode-activity*.svg`、`AeroOpenCodeLogo`、`ProviderModelIcon` 彩色分支；`WelcomeScreen` 去掉写死 `#555` |
| 10.3 | 新会话默认背景 | ✅ | `.messages-shell.is-empty-state`（径向极光 + 20px 点阵 + light 变体）；与 idea 的 `.chat-screen-shell.is-empty-state` 效果等价（本仓无该壳层，方案已注明偏离） |
| 10.4 | 模式列表 | ✅ | `store/agentStore` + `ModeSelect` + `modeColors`；`agents.list` → `AgentHandler.refresh`。**注意**：宿主不会在 `view.ready`/配置变更后主动推 `agents.updated`，只在 webview 请求时推（G15） |
| 10.5 | 模型列表与置顶 | ✅ | idea `ModelSelect` 整份移植（长按 180ms 拖拽 + `writePinnedModelIds`）、`selectors.css`；保留 `useDropdownPosition` |
| 10.6 | 推理力度 | ✅ | `reasoningUtils` + `types.getAvailableReasoningLevels` 均为 idea 版；`settings.reasoning` per tab |
| 10.7 | 权限弹窗 | ✅ | `SessionCallbackAdapter` 盖 `tabId/sessionId`；`PromptRegistry` 登记/关 tab 拒绝；后台 tab 排队 + 角标；A24 起答复改走 v2 `permission.reply` / `question.reply` / `plan.reply`，`PermissionHandler` 校验 pending 的 tab/session 归属，过期或串 tab 的答复直接丢弃 |
| 10.8 | 问题弹窗 | ✅ | 同一套归属；超时=拒绝+中断会话+关卡片；`questionAnswerStore` 按 `callId` 失效；答案卡 |
| 10.9 | 状态面板三子页 | ✅ | 展开/子页按 tab（`useTabBarState.statusPanelTab`）；`task`/`todos`/`files.undo` 按 tab；`resolveSubagentRunState` 统一；`subagent.history` 宿主 handler 已补（G3）；`StatusPanel.less` 与 idea 已逐字节一致（毛玻璃胶囊样式已移植） |
| 10.10 | 添加附件 | ✅ | `TabAttachmentStore`（32MB、分块顺序、按 tab 落盘、关 tab `releaseTab`）；发送只带 `attachmentId`；切 tab 由 `tabDraftStore.attachments` + `useTabSessionBinder` 恢复。**待人工**：10MB 图片、粘贴/拖拽/选择三入口 |
| 10.11 | 引用文件 `@` | ✅ | `files.list`（按目标 tab cwd）→ `files.listed`；`useFileTags.restoreFileTags` 切 tab 重建 chip |
| 10.12 | 文件上下文 | ✅ | `autoOpenFileEnabled` 三态 + `autoOpenFileEnabledResolver` 按 tab 注入（`OpenCodeSession.ts:170`）；`context.refresh` 落 `TabSettings`；`ChatWindow.createSessionForTab` 注入 `contextEnabledResolver`，`OpenCodeSession` 发送前读取 `isContextEnabled()`，关闭 Context Bar 即停止注入活动文件/选区（显式 `@` 引用不受影响） |
| 10.13 | bash `!` | ✅ | `TabSessionSendHandler` 的 `!cmd` 分支取目标 tab 的 cwd；legacy `SessionHandler` 保留兜底 |
| 10.14 | opencode `/` | ✅ | `commands.refresh` 按 tab cwd + `slash.commands` 按 tab 投递 + 前端 `commandsByTab`；未知命令回退普通消息（`KnownCommands`）；`SHARE_MENU_ENABLED=false` |

---

## 4. 2026-10-29 审计新发现（按严重度）

| ID | 状态 | 问题 | 本轮修复 / 证据 |
|---|---|---|---|
| **G1** | ✅ | 多视图运行时同步未接线 | webview 注册 `tab.created/closed/activated/reordered/draft.changed`、`prompt.host.changed`、`view.navigate`；发送 `view.ready/focus/navigate`、`tab.reorder`、`tab.draft.changed`；`selectTab(..., {fromHost:true})` 防回声；宿主回放延后一拍保证顺序 |
| **G2** | ✅ | `TabStatusStore` 快照交换违反 INV-9 | 删除 `tabStatusStore.ts` 与全部 `statusStore.set/get/delete`；切 tab 时把活跃视图的 turn/stream 状态写入 tab 记录，切回只读记录 |
| **G3** | ✅ | `subagent.history` 无宿主 handler | `ChatWindow` 注册 `subagent.history` → `ChatInstance.loadSubagentHistory` → `HistoryHandler.handleLoadSubagentSession` |
| **G4** | ✅ | webview 测试类型检查 16 错 | 修 10 个测试文件的 props/类型/未用变量；`tsc -p tsconfig.test.json --noEmit` 0 错 |
| **G5** | ✅ | 宿主测试被过期 `out/` 产物污染 | `package.json` 新增 `clean:out`，`pretest` 先清理再 `compile-tests`；宿主 108 passing / 0 failing |
| **G6** | ✅ | §5.5 删除清单未清 | 删除 `skipNewSessionConfirm`（文件/偏好/设置开关/确认弹窗）、6 个分享死文案、`open_class`、legacy `send_message/send_message_with_attachments/interrupt_session` 兜底 |
| **G7** | ✅ | tab 重命名不同步服务端标题 | 新增宿主 `session.rename`（`opencode.updateSessionTitle`）；`renameTab` 在有 sessionId 时发送 |
| **G8** | ✅ | 数据面仍是投影式 legacy 通道 / 命令面 v2 未对齐 | `SessionCallbackAdapter` / `StreamMessageCoalescer` 全部改为命名 `TabEvent`；`TabEventRouter` 按 tab 分 lane；webview `streamingCallbacks` 注册 `content.delta`/`thinking.delta`/`message.snapshot`/`message.tail`/`turn.*`/`session.*`/`tab.state`/`message.error` 等 handler，后台 tab 写自己的 `messageStore` 与记录；`TabScopedSink` 已删除。命令面：`fork`/`compact`/`share`/`revert` 改用 core 真实方法名，fork 目标 tab 由宿主绑定，webview 改发 v2 命令 |
| **G9** | ✅ | §8.3 引擎 UI 缺失 | `StatusNoticeBar` 增加 engine 分支（`blocking`/`unknown` → 原因/版本 + 重新检测）；`EnvironmentTab` 增加引擎状态卡（状态/锁定/阻塞/CLI 版本/来源/路径/API 版本/原因） |
| **G10** | ✅ | 护栏覆盖不足 | `multiSessionGuardrails.test.ts` 新增：`PermissionHandler` 禁止借用活跃会话、webview `bridge.ts` 禁止 legacy 发送 |
| **G11** | ✅ | 命令/弹窗仍可回落活跃 tab | 缺 tabId 的 tab 级命令直接 `MISSING_TAB_ID`；`PermissionHandler` 去掉 `?? getSession()`，缺失身份仅记日志 |
| **G12** | ✅ | §7.14 快捷键/无障碍未做 | `role=tablist`/`role=tab`/`aria-selected`/roving `tabIndex`；Alt+T/W/1-9/←→；F2/Delete/Enter/Space |
| **G13** | ✅ | daemon 重启无 per-tab 终态 | `ChatWindow.handleDaemonDied()` 清所有会话 loading/busy，活跃视图收 `onStreamEnd{reason:'daemon_restart'}`；`extension.ts` 接线 |
| **G14** | ✅ | 事件目录两端不一致 | 两端均 148 项；新增跨端一致性测试（直接读宿主源码比对，防再次分叉） |
| **G15** | ✅ | agent 目录只在请求时推 | `view.ready` 时主动 `requestAgents()`；配置变更后的外部热载仍依赖下一次请求（低风险） |
| **G16** | ✅ | 状态面板视觉未对齐 | 移植 idea 的毛玻璃 tab 头/浮层（含 light 主题）与 `status-cancelled` 样式 |

---

## 5. 两仓对比（2026-10-29，`webview/src`）

| 指标 | idea | vscode |
|---|---|---|
| 文件数 | 742 | 737 |
| 内容完全一致 | **505** | 505 |
| 同名分叉 | **220**（测试 70 / less 12 / css 1 / i18n 10 / 其他源码 127） | 同 |
| 仅 idea 有 | 17 | — |
| 仅 vscode 有 | — | 12 |

**仅 idea 有（17）**：`PromptSection`（2，IDEA-only，方案 §9 明确不搬）；JCEF/Node 专用 `forceWebviewRepaint`(+test)、`nodeProcessCapabilities`(+test)、`surfaceDamagePulse`(+test)（6，不搬）；idea 分发式架构测试 7 个 + `copyUtils.test`（8，两套架构不可互换）。

**仅 vscode 有（约 14）**：保留 `wxq.png`、`test/testEvents.ts`、`types/protocol.ts`、7 个本仓测试；A21 新增 `utils/draftSync.ts`、`utils/viewIdentity.ts`、`utils/semanticEvents.parity.test.ts`；**已删**：`utils/skipNewSessionConfirm.ts`（G6）。

**分叉最大的源文件**（diff 行数）：`messageCallbacks.ts`(920)、`App.tsx`(724)、`streamingCallbacks.ts`(548)、`registerCallbacks.ts`(360)、`StatusNoticeBar.tsx`(352)、`main.tsx`(296)、`global.d.ts`(292)、`permissionCallbacks.ts`(290)、`useSessionManagement.ts`(226)、`MessagesContext.tsx`(214)。差异主要来自两套事件总线（投影式 vs 分发式）与 VS Code 专属功能（daemon 失败分类、`verboseDiagnostics`），不是遗漏。

### 5.1 idea 0.3.0 有、本仓未搬（不属于方案 §10 的 14 项）

| 能力 | idea 落点 | 本仓 | 处置建议 |
|---|---|---|---|
| Markdown 解析结果 LRU（300 条，切 tab/重载不重解析） | `components/MarkdownBlock.tsx`（`HTML_CACHE_LIMIT=300` + `clearMarkdownHtmlCache`） | ✅ 已移植（`renderCachedMarkdownHtml` + 300 条 LRU，流式尾块不缓存） | 已完成 |
| 常驻 terminal error 通知（跨重挂载保留，`turn.error` 语义事件驱动） | `StatusNoticeBar.tsx`（`setTerminalError` / `onTerminalErrorFromHost`，`main.tsx:450` 注册 `turn.error`） | 错误落为消息行，`turn.error` 无 sender/handler | 可选；先补 `turn.error` 事件再谈 UI |
| 状态面板毛玻璃胶囊 | `StatusPanel.less` | 旧底色/直角（G16） | 视觉对齐时一起做 |
| 命令管理设置页 `PromptSection` | `components/settings/PromptSection` | 无 | 方案 §9 明确**不搬** |
| JCEF 帧治理 / Node 进程管理 | `forceWebviewRepaint` / `surfaceDamagePulse` / `nodeProcessCapabilities` | 无 | 方案 §9 明确**不搬** |
| Java2D `AeroLoadingPanel` | `AeroLoadingPanel.java` | 不适用（VS Code 无原生首帧面板） | 用现有 boot splash 等价替代 |

---

## 6. 验收记录（2026-10-29 实跑）

| 命令 | 结果 |
|---|---|
| `pnpm run compile`（tsc + eslint + esbuild） | ✅ |
| `cd webview && pnpm run build`（tsc + vite + copy-dist） | ✅（9.72MB 单文件） |
| `webview: npx vitest run` | ✅ **178 文件 / 1476 项**通过 |
| `webview: tsc -p tsconfig.test.json --noEmit` | ✅ 0 错 |
| `pnpm test`（宿主，`pretest` 先 `clean:out`） | ✅ **119 passing / 0 failing** |
| `pnpm run unlink:core && pnpm run package` | ⬜ 未复跑（需网络） |

**端到端手工项仍未做**：2 视图 + 3 tab + 2 并发流；关视图再开；关最后一个 tab；daemon 重启；v1/v2 各一遍；10MB 附件三入口。

---

## 7. 下一步（按优先级）

1. **P9 多视图手工矩阵**：2 视图 + 3 tab + 2 并发流；关视图再开；关最后一个 tab；daemon 重启；
   v1/v2 各一遍；10MB 附件三入口。重点验证 G8 后后台 tab 的实时徽标/消息、reload epoch 拒旧事件。
2. **P9 发布验证**：在无 link 的干净依赖环境跑 `pnpm run unlink:core && pnpm run package`，
   确认产物使用 GitHub Release 的 `opencode-buddy-core`；再跑一遍多视图手工矩阵
   （左右侧栏 + 编辑器 panel 同时打开：切 tab / 新建 / 关闭 / 拖拽 / 草稿 / 权限弹窗归属 / 页面切换）。
3. **可选增强**：`turn.error` 常驻通知（`turn.error` 已发布，`StatusNoticeBar` 仍走错误消息行）；
   `assets/.DS_Store` 清理。
---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-29 | **P9-A25（本轮）**：按文件从 idea 同步剩余 UI/交互：①历史页“深度搜索”刷新按钮（`HistoryActions` + `HistoryView` 30s 超时/自动收尾；宿主 `HistoryHandler` 接收 `history.deepSearch` / `deep_search_history` 并重载列表）；②Shift+Tab 改为循环宿主推送的全部 primary agent（`getNextPrimaryMode`），不再写死 Build/Plan；③生成指示器按整个 turn（`loading || streamingActive`）显示，避免 `loading=false` 时流式输出被隐藏；④`CompactSummaryBlock` 换成 idea 的紧凑胶囊样式；⑤锚点栏过滤 tool_result/合成用户消息，单条用户消息也显示锚点；⑥工具块以 `result.is_error` 为准，denied 仅在无结果时作为错误态；⑦模型选择器支持 `provider/model` 后缀匹配、默认模型回退与 `opencode-default` 立即纠偏。新增/更新前端测试（历史深度刷新、Shift+Tab、等待指示器、锚点/消息工具函数、工具块、模型纠偏）。实跑：宿主 **119 passing**、webview **1488**、编译/构建 ✅。
| 2026-10-29 | **P9-A24（本轮）**：①提示答复命令面 v2：webview 权限/提问/计划答复从 legacy `permission_decision` / `ask_user_question_*` / `plan_approval_response` 切到 `permission.reply` / `question.reply` / `plan.reply`；ChatWindow 注册三类命令并把 envelope sessionId 注入 payload，`PermissionHandler.handleReplyCommand` 校验 pending 的 tab/session，串 tab 的迟到答复拒绝。②移植 idea `StatusNoticeBar` 的 `turn.error` 终端提示：模块级 terminal error 缓冲、语义事件优先于 transcript error row、`noticeKeyFor` 按最新用户 prompt 锚定、server 文案/动作优先；`streamingCallbacks` 的 `turn.error` 同步喂给提示条。新增宿主 prompt 归属测试(3)、webview 提示条/回复命令测试。实跑：宿主 **119 passing**、webview **1483**、编译/构建 ✅。
| 2026-10-29 | **P9-A23（本轮）**：命令面 v2 对齐。`TabSessionCommandHandler` 重写为 idea 语义：`opencode.fork`（原 `forkSession`）、`opencode.summarize`（原 `compact`）、`opencode.shareSession`/`unshareSession`、`opencode.revert`/`unrevert`；补 fork 目标 tab `bindForkedSession`、revert 指针解析与状态回写、share URL 解析、latest 用户消息解析（state → listMessages 兜底）；事件统一 `legacy:false` 并发布 `session.fork.bound`/`session.fork.failed`/`session.share.*`/`session.revert.failed`/`session.compact.*`。webview `App` 的 fork/compact/revert/share/unshare 改为 `sendHostCommand`/`sendSessionCommand`，新增命名结果 handler 与 `onForkBound` 目标 tab 打开。新增宿主 `tabSessionCommands`(5)。实跑：宿主 **116 passing**、webview **1476**、编译/构建 ✅。
| 2026-10-29 | **P9-A22（本轮）**：G8 数据面重写完成。`SessionCallbackAdapter` / `StreamMessageCoalescer` 全部改为命名 `TabEvent`（`content.delta`、`thinking.delta`、`message.snapshot`、`message.tail`、`turn.started`、`turn.ended`、`session.loading`、`session.bound`、`session.cleared`、`session.loaded`、`tab.state`、`message.error` 等），带 `tabId`/`sessionId`/`turnId`/`seq`，经 `TabEventRouter` per-tab lane 广播；webview 按 `envelope.tabId` 写 `TabMessageStore` / tab 记录，仅活跃 tab 更新 React。删除 `TabScopedSink` 及其后台丢弃逻辑；`replayTab` / `handleDaemonDied` / `resetSession` / `restoreMessages` / 附件与发送错误均改为命名事件。新增宿主 `tabDataPlaneEvents`(3) 与 `tabDataPlaneWiring`(1)、前端 `useWindowCallbacks` 后台路由(4)。实跑：宿主 **111 passing**、webview **1476**、编译/构建 ✅。
| 2026-10-29 | **P9-A21（本轮）**：按 A20 审计结果收口，除 G8 外全部修复。
<br>① **多视图（G1/G2/G12）**：webview 接线 `tab.created/closed/activated/reordered/draft.changed`、`prompt.host.changed`、`view.navigate`，发送 `view.ready/focus/navigate`、`tab.reorder`、300ms 防抖的 `tab.draft.changed`（带 `sourceViewId` 回声抑制）；`selectTab` 增加 `fromHost` 模式；关闭活跃 tab 不再预选邻居；宿主 `tab.activated` 回放延后一拍，避免快照先于切换到达。删除 `TabStatusStore`，切 tab 状态写回 tab 记录。标签栏补 `role=tablist/tab`、Alt+T/W/1-9/←→、F2/Delete。
<br>② **断链与删除（G3/G6/G7）**：注册宿主 `subagent.history`、`session.rename`；删除 `skipNewSessionConfirm` 全链路、二次确认弹窗、设置开关、6 个分享死文案、`open_class`、legacy `send_message/send_message_with_attachments/interrupt_session`。
<br>③ **归属与生命周期（G9/G11/G13/G15/INV-7）**：缺 tabId 的 tab 级命令直接拒绝（白名单 `agents.list`/`commands.refresh`/`session.new`）；`PermissionHandler` 去掉 `?? getSession()`；`ChatWindow.handleDaemonDied()` 清理所有会话并给活跃视图终态；`view.ready` 主动推 agent；新增 `unattributedCount`；`StatusNoticeBar`/`EnvironmentTab` 补引擎 UI。
<br>④ **功能与视觉（10.9/10.12/G16）**：`contextEnabled` 从 `TabSettings` 解析到 `OpenCodeSession.send`，关闭后不注入活动文件/选区（显式 `@` 仍生效）；状态面板移植毛玻璃与 `status-cancelled`；Markdown 增加 300 条 HTML LRU。
<br>⑤ **测试门（G4/G5/G10/G14）**：修 10 个测试文件的 16 个类型错误；`pretest` 先 `clean:out`；新增跨端事件目录一致性测试；护栏扫 `PermissionHandler` 与 webview `bridge.ts`。实跑：`pnpm run compile` ✅、`webview pnpm run build` ✅、webview vitest **178/1472** ✅、`tsc -p tsconfig.test.json` 0 错、宿主 **108 passing** ✅。
<br>**唯一未做**：G8（数据面命名事件 + per-tab lane）——需要重写 `SessionCallbackAdapter`/`content.delta` 与 webview 事件路由，属独立架构任务。
| 2026-10-28 | 建立文档；记录 P0–P7 架构主干落地 |
| 2026-10-28 | **更正**：P8/P9 此前误标完成；补 14 项功能域核查（对应方案 §10），列出 21 处 `getSession()` 与缺失的宿主命令 |
| 2026-10-29 | **P9-A20**：两仓全量对比审计（`webview/src` 742 vs 737：505 一致 / 220 分叉 / 17 vs 12 独有），逐章核对方案 §3–§11 并实跑编译与测试。确认：单视图多 tab 可用；**多视图运行时同步未接线**（宿主 8 类广播无 webview 消费方，`view.ready/focus` 从不发送）；**`TabStatusStore` 仍在做快照交换**；**A19 引入 `subagent.history` 断链**（展开子代理详情空白）；webview 测试类型检查 16 错；宿主测试被 2 个过期 `out/test` 产物污染（清理后 106 全绿）；`semanticEvents` 缺 8 个新增键；§5.5 删除清单残留二次确认/分享文案/`open_class`/legacy 命令；`contextEnabled` 只写不读；§8.3 引擎 UI 未做；§7.14 快捷键与无障碍未做。详见 §4（G1–G16） |
| 2026-10-29 | **P9-A19**：终验前的**两仓逐文件比对**（webview 658 → 585+563 文件）。用 idea 的 31 个测试文件当「探针」，逐个跑，暴露 8 处真实缺口并修复：
<br>① **会话切换守卫从全局 flag 改为 per-tab**（§5.5 要求删 `sessionTransition.ts` + `__sessionTransitioning`）。此前是**窗口级** `window.__sessionTransitioning`：后台 tab 切会话时，前台 tab 的流式事件会被 `if (window.__sessionTransitioning) return` 丢弃 —— 这是 §10.9 隔离的真实缺陷。已改用既有的 `tabTransitionStore`（per tab）；`resetTransientState.ts`（idea 版）此前**从未被接线**，现在接上了；`sessionTransition.ts` 已删除。
<br>② **模型/推理力度/权限模式改走 v2 per-tab 命令**（`settings.model` / `settings.reasoning`）。此前 webview 发 legacy `set_model` / `set_reasoning_effort`，宿主写进**全局** context：tab A 换模型会连带改掉 tab B。宿主新增两个 v2 handler（`ChatWindow`），并支持 `silent`（切 tab 回放自己的模型时不清空用量环）。同时修 `reasoningEffort` 默认值 `'medium'` → `'default'`（多数 opencode 模型没有 `medium` 档）。
<br>③ **`agentProvider` 整份照搬 idea**：此前是模块级缓存 + `sendBridgeEvent('get_agents')`，与 §10.4 要求的「宿主是 agent 列表的唯一权威」不符（`ModeSelect` 已订阅 store，但 `@` 下拉与 Shift+Tab 仍走旧路）。
<br>④ **`AgentGroupBlock` + `subagentResult` 照搬 idea**：此前把「子代理 transcript 已结束」当终态（卡片提前转 completed），idea 明确规定 transcript **只是详情来源**、终态只能来自 core 的 `subagent.status`；同时补上 opencode v2 的 `agent` 参数名与 `background: true`。（**A20 发现**：本次移植漏了宿主 `subagent.history` handler，见 G3。）
<br>⑤ **`useQuoteTags` 补 quote 按 tab 持久化**（`restoreQuoteTags` / `extractQuotes` + `quoteRegistry.restoreQuotes` + `pruneQuoteRegistry` 的 `preservedIds` 跨 tab 保护）；`ChatInputBoxHandle` 补 `getAttachments`/`setAttachments` —— 此前 `useTabSessionBinder` 的草稿附件恢复是**死代码**（handle 上没有这两个方法）。自建的 `usePerTabAttachments` 删除，改用 idea 的 `useResetAttachmentsOnSessionChange`；附件草稿仍由 `tabDraftStore` 按 tab 保存。
<br>⑥ **复制通道死链**：`write_clipboard` 在本仓宿主无 handler（idea 的 Java `ClipboardHandler` 三种拼写都收）→ 右键复制/剪切完全无响应。改为 `copy_to_clipboard`。
<br>⑦ **外链死链**：`open_browser` 在本仓宿主同样无 handler → markdown 里的外链点不动。改为宿主已有的 `open_external_url`，并把宿主协议白名单放宽到 `mailto:`。
<br>⑧ **删除「有 UI 无后端」的遗留功能**（方案 §5.5 D 类清单）：深度搜索（`deep_search_history`）、会话转 CLI（`convert_to_cli_session` 全链路）、Node 进程管理（`nodeProcessCapabilities`）、JCEF 帧治理（`surfaceDamagePulse` / `forceWebviewRepaint`）、自定义模型定价同步（`set_custom_model_pricing`）、thinking 开关（`set_thinking_enabled`，`ButtonArea` 根本不渲染它）。
<br>顺带**补上 idea 有、vscode 缺的两个真实功能**：历史列表加载失败/超时的**重试按钮**（`onRetry` + `loadTimedOut`）、消息列表渲染的**错误边界**（`MessagesErrorBoundary`）。10 个语言包同步增删（`history.retry` / `history.loadTimeout` / `chat.renderError` / `common.retry` 入，5 个已废的转换/深度搜索键出）。
<br>**架构性偏离（不搬）**：idea 的 7 个测试文件（`messageCallbacks.historyRouting` / `permissionPromptRouting` / `subagentHistoryRouting` / `subagentStatusRouting` / `todoCallbacks` / `turnEnd` / `sequenceBarrier`）依赖 idea 的**分发式事件总线**（`hostEventHandler('message.snapshot')` 等）；本仓是**投影式**（宿主 `TabScopedSink` 只推活跃 tab，webview 走 legacy `window.<fn>`）。这类测试在两套架构下不可互换，已按本仓架构删除，并保留/新增等价覆盖（`permissionRouting` 6 项、`todoRouting` 4 项、`useSessionTabsMultiSession` 21 项、`slashCommandProvider.perTab` 2 项）。
<br>**顺带修一个既有技术债**：宿主测试分两派 —— 13 个文件用 BDD（`describe`/`it`），10 个文件用 TDD（`suite`/`test`），而 `@vscode/test-cli` 的 mocha 固定 `ui: 'tdd'`。**结果：那 13 个 BDD 文件从来没真正跑过**（一加载就抛 `describe is not defined`，整个套件直接 exit 1）。已把 13 个文件统一成 TDD（含 `beforeEach`→`setup`、`afterEach`→`teardown`），宿主测试这才第一次真正跑起来。 |
| 2026-10-28 | **P8-A4**：新增 `util/SlashCommandCatalog.ts`（命令列举单一实现）与 `window/TabContextCommandHandler.ts`；`ChatWindow` 注册 `context.refresh` / `commands.refresh`；移除 `WindowEventHandler` 的 `refresh_slash_commands`；webview 改发 `commands.refresh`。补 §2.3 命令面缺口清单与 A1 前置条件 |
| 2026-10-28 | **P8-A1/A2**：`ChatWindow` 接线 `TabSessionFactory`（每 tab 一个会话）+ `TabScopedSink` 投影 + 切 tab 快照回放；`SessionManager` 注入 resolver/lookup/replacer；`ChatInstance` 合并为全窗口单例（`BroadcastWebviewChannel`）；新增 `session.send` / `session.interrupt` / `session.new` 命令。测试 `tabSessionOwnership`（7 项） |
| 2026-10-28 | **P8-A18**：§10.14 斜杠命令 —— 列表按 tab（宿主 `slash.commands` 语义事件按 tab 投递 + webview 按 tab 缓存与节流）；未知命令回退普通消息（移植 idea 的 `KnownCommands`，自定义命令以服务端公布名单为准）；顺带修 **legacy 副本**问题：事件路由器会同时投递 v2 批次与 legacy 回调，前端据此区分「某个 tab 的事件的副本」（忽略）与「窗口级回放」（采纳）。测试：宿主 `slashCommands`(4)，前端 `slashCommandProvider.perTab`(2)；**修 `scripts/run-tests.mjs` 的写死分组**（新增测试文件此前根本没进全量运行） |
| 2026-10-28 | **P8-A17**：§10.12 `autoOpenFileEnabled` 真正按 tab 生效 —— `OpenCodeSession` 新增 `autoOpenFileEnabledResolver`（`ChatWindow` 按 tab 记录提供），`TabSettings.autoOpenFileEnabled` 改三态（未设置=跟随全局项目设置）。测试 `tabAutoOpenFile`(1) |
| 2026-10-28 | **P8-A16**：`todos` 事件按 tab 路由（`onTodoUpdated` 按 sessionID 反查归属 tab，后台 tab 的待办写进该 tab 而非丢弃；字段名/状态归一同 idea）；附件草稿按 tab 保存（后由 A19 改为 `tabDraftStore.attachments` + `useTabSessionBinder` 恢复）。测试：前端 `todoRouting`(4) |
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
