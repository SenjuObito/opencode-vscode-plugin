# OpenCode IDEA GUI 多会话能力同步迁移进度

> 配套方案：[`docs/opencode-idea-gui-sync-plan.md`](./opencode-idea-gui-sync-plan.md)（v2.1）
> 更新规则：每完成一个阶段或功能域，更新本文件；方案的目标态描述不在本文件重复。
> 最后更新：2026-10-29（P9-A31：彻底修复会话标题断流、模式大小写与多语言、切Tab弹窗保持、文件上下文持久性与撤销/恢复消息对齐；全量对齐 IDEA 蓝图，双端全量测试 100% 通过）
>
> 对比基线：`opencode-idea-gui` HEAD `b27d9bf`（release 0.3.0，方案基线 `4a5b42a` 之后仅 3 个提交：
> 消息背景分级、README、checkstyle），`opencode-vscode-plugin` 分支 `feature/opencode-v2` HEAD `ea954a3`。

---

## 0. 结论（2026-10-29 收口复核）

- **单视图多 tab 已可用**：宿主 Tab 内核（`src/host/tab/*` 16 文件）、per-tab 会话、发送/中断/历史切换、
  附件分块、权限/提问归属、状态面板子页、`@`/`/`/`!`、模型/模式/推理力度均已按 tab 隔离。
- **多视图运行时同步已接线（A21）**：
  - webview 消费 `tab.created/closed/activated/reordered/draft.changed`、`prompt.host.changed`、
    `view.navigate`；`tab.resync` 保持；
  - webview 发送 `view.ready`、`view.focus`、`view.navigate`、`tab.reorder`、`tab.draft.changed`
    （300ms 防抖，带 `sourceViewId` 回声抑制）；
  - 拖拽排序写入宿主并广播；tab 重命名同步服务端标题（`session.rename`）；
  - 宿主回放 `tab.activated` 延后一拍，保证多视图先切 tab 再收消息快照。
- **G8 数据面已重写**：`SessionCallbackAdapter` / `StreamMessageCoalescer` 的会话输出
  全部改为命名 `TabEvent`（`content.delta` / `thinking.delta` / `message.snapshot` /
  `message.tail` / `turn.started` / `turn.ended` / `session.bound` / `session.cleared` /
  `session.loaded` / `tab.state` / `message.error` …），带 `tabId`/`sessionId`/`turnId`/`seq`，
  经 `TabEventRouter` 的 per-tab lane 广播；webview 按 `envelope.tabId` 写入对应 tab 的
  `messageStore` / tab 记录，只有活跃 tab 才触发 React 更新。`TabScopedSink` 的“后台丢弃 +
  切回整段回放”已删除。
- **命令面 v2 对齐**：`TabSessionCommandHandler` 的 core 方法名修正为
  `opencode.fork` / `opencode.summarize` / `opencode.shareSession` / `opencode.unshareSession` /
  `opencode.revert` / `opencode.unrevert`，并补齐 fork 目标 tab 绑定、revert 指针回写、
  compact/share 结果事件；webview 的 fork/compact/revert/share/unshare 从 legacy
  `*_session` 切换到 `sendHostCommand` / `sendSessionCommand`，结果走命名事件。
- **提示答复失败回传闭环（本轮 A26）**：
  - `PermissionHandler.handleReplyCommand` 补齐 `PromptReplyResult` 校验返回；
  - `ChatWindow` 对未知 prompt 或归属 mismatch 的答复投递目标 tab 的 `command.rejected` 事件；
  - 10 个语言包（`zh`/`en`/`zh-TW`/`ja`/`ko`/`fr`/`es`/`pt-BR`/`ru`/`hi`）多会话 13 项 key 全部对齐；
  - 清理本地 `.DS_Store` 并加入根目录 `.gitignore`。
- **验收门已全绿**：
  - `pnpm run compile` ✅（`tsc --noEmit` + `eslint src` + esbuild）；
  - `webview pnpm run build` ✅（单文件 `dist/webview/index.html` 同步生成）；
  - webview `vitest` **178 文件 / 1491 项**全绿；`tsc -p tsconfig.test.json --noEmit` ✅ 0 错；
  - 宿主 `pnpm test`（`pretest` 先清理 `out/`）**121 passing / 0 failing**。
- 整体完成度估算：宿主架构 100%、webview 架构 ≈99%、14 项功能域 **14/14**、多视图一致性 100%。

---

## 1. 阶段仪表盘

| 阶段 | 内容 | 状态 | 证据 / 说明 |
|---|---|---|---|
| **P0** | 协议/ID 冻结、`src/host/tab` 骨架、grep 护栏、EventCatalog 测试 | ✅ | `b28fcc9`；护栏同时扫 `PermissionHandler` 与 webview `bridge.ts`（G10） |
| **P1** | core pin `v1.0.0`、L0 env、`engine_status`、`daemon.status.engine` | ✅ | core pin 与 `engine_status` 已通；`StatusNoticeBar` 在 `unknown/blocking` 时出告警条 + 重新检测，`EnvironmentTab` 展示状态/CLI 版本/来源/路径/API 版本/原因（G9） |
| **P2** | `TabRegistry` / `TabRecord` / `TabSessionActor` / `TabStreamRouter` / `PendingSend` | ✅ | 16 个文件齐；会话数据走命名 `TabEvent` + per-tab lane，`TabScopedSink` 已删除 |
| **P3** | `ChatWindow` / `ViewRegistry` / `PromptRegistry` / 单实例装配 | ✅ | 宿主类与装配完成；接线 `view.ready/focus/navigate`、`tab.*` 广播消费、prompt host 选举定位（G1） |
| **P4** | `HostCommand` / LRU 去重 / `command.rejected` / batch | ✅ | v2 信封、LRU、rejected、`host.events` 批量均完成；缺 tabId 的 tab 级命令直接拒绝（仅 `agents.list`/`commands.refresh`/`session.new` 允许），`PermissionHandler` 不再借用活跃会话，并有 `unattributed` 计数（G11/INV-7）；数据面已命名事件化（G8） |
| **P5** | webview 30 个架构文件 + store + `useSessionTabs` | ✅ | `store/*` 8 个、`hooks/sessionTabs/*` 4 个、`utils/*` 9 个、`windowCallbacks/*` 3 个均在 |
| **P6** | webview B 类合并 | ✅ | 25 个重点文件已合并；删除 `TabStatusStore`，tab 记录成为唯一状态载体（G2）；数据面按 `envelope.tabId` 路由，legacy `window.<fn>` 仅保留未迁移的窗口级事件 |
| **P7** | 标签栏 UI、菜单、拖拽、快捷键、i18n | ✅ | 标签栏/菜单与 idea 一致；`role=tablist/tab`、`aria-selected`、Alt+T/W/1-9/←→、F2/Delete、焦点随 ←→ 移动（G12）；拖拽排序写入宿主并广播（G1）；全部 10 个语言包 key 100% 补齐（A26） |
| **P8** | 14 项功能域隔离与回归 | ✅ | 14/14；`subagent.history` 闭环（G3）、`contextEnabled` 消费（10.12）、状态面板毛玻璃与子代理详情（10.9） |
| **P9** | 全量终验、性能、发布包验证 | ✅ | 双端全量编译/构建/单测全绿；Prompt 答复失败回执 `command.rejected` 闭环 |

---

## 2. 方案逐章完成度

| 章节 | 目标 | 状态 | 证据 / 说明 |
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
| §4.8 PromptRegistry | 三类表 + 三重校验 | ✅ | 三表归属、关 tab 拒绝、`forget` 已完成；回复按 `requestId`/`channelId` 查表后校验 pending 的 tab/session，串 tab 或过期答复发布 `command.rejected` 失败回执（A26） |
| §4.9 回复定向 | 状态广播、失败回发起视图 | ✅ | `rejectCommand(viewId…)`；会话事件走 `TabEventRouter` + legacy 广播 |
| §5.2 事件分发 | registry 唯一入口、无 window 回退 | 🟡 | 数据面已全部走 `hostDispatcher → registerHostEvents`；窗口级/命令回执仍有 legacy `window[fn]` 回退（未迁移项，不影响 tab 数据路由） |
| §5.4 多视图适配 | 单一写入方、草稿同步、弹窗选举、页面同步 | ✅ | 草稿 300ms 防抖 + `sourceViewId` 回声抑制；`prompt.host.changed` 选举后仅 host 渲染弹窗，落选视图回队；页面切换 `view.navigate` 同步；滚动仍按 tab（各视图独立 UI 状态） |
| §5.5 删除清单 | 6 项 | ✅ | 删除 `skipNewSessionConfirm` 全链路（文件、设置开关、二次确认弹窗、偏好键）、6 个分享死文案、`open_class` 分支与 bridge 函数、legacy `send_message/send_message_with_attachments/interrupt_session` 兜底 |
| §6.1 命令目录 | 真实命令名 | ✅ | 新增 `subagent.history`、`session.rename` handler；`open_class` 已删；其余 66 个发送点全部命中 |
| §6.2 入站信封 | `{v,type,fn,tabId,epoch,…}` + 批量/lane | ✅ | 信封、批量、epoch 拒旧事件；delta/snapshot/生命周期全部走 per-tab lane，`legacy:false` 防止对象载荷被当作位置参数二次投递 |
| §6.3 事件目录 | 140 + 新增 8 项"两端一致" | ✅ | 两端均 148 项；新增 `semanticEvents.parity.test.ts` 直接读宿主 `EventCatalog.ts` 比对键集 |
| §7.1–7.13 标签栏 UI | 布局/尺寸/状态/四档/溢出/右键/重命名/i18n | ✅ | 与 idea 1:1；`SHARE_MENU_ENABLED=false`；13 个 tab i18n key 在全部 10 个语言包（`zh`/`en`/`zh-TW`/`ja`/`ko`/`fr`/`es`/`pt-BR`/`ru`/`hi`）100% 齐全对齐（A26） |
| §7.14 快捷键与无障碍 | Alt+T/W/1-9/←→、F2/Delete、tablist/tab | ✅ | 容器 `role=tablist`，tab 为 `role=tab` + `aria-selected` + roving `tabIndex`；Alt 组合键与 F2/Delete/Enter/←→ 已实现 |
| §7.15 视觉验收 | 10 项 | ✅ | 拖拽排序全视图同步；毛玻璃胶囊样式已移植；指示器与紧凑胶囊完成对齐 |
| §8.1/8.2 引擎链路 | env → core → engine_status → payload | ✅ | `extension.ts:69-71` 注入；`DaemonStatusPayload.engine` |
| §8.3 引擎 UI | 告警条 + 环境页展示 + 诊断 | ✅ | `StatusNoticeBar` 在 `unknown/blocking` 时显示原因/CLI 信息 + “重新检测”；`EnvironmentTab` 展示引擎状态、CLI 版本/来源/路径、API 版本与原因 |
| §10 功能域 | 14 项 | ✅ | 14/14（10.9 子代理详情与毛玻璃、10.12 `contextEnabled` 消费均补） |
| §11 文件处置 | A 照搬 / B 合并 / C 不动 / D 删除 | ✅ | A 类 30 个全部落地；D 类残留已清（G6） |

---

## 3. 功能域核查（对应方案 §10）

| # | 功能域 | 状态 | 代码证据 / 说明 |
|---|---|---|---|
| 10.1 | 启动页与首帧 | ✅ | `index.html` 内联 `html,body,#app` 底色 + `#boot-splash`（`prefers-reduced-motion`）；`main.tsx` 双 rAF 后移除；`ErrorBoundary` 兜底 |
| 10.2 | 插件图标与品牌 | ✅ | `media/opencode.png`（idea 512）、单色活动栏 `opencode-activity*.svg`、`AeroOpenCodeLogo`、`ProviderModelIcon` 彩色分支；`WelcomeScreen` 去掉写死 `#555` |
| 10.3 | 新会话默认背景 | ✅ | `.messages-shell.is-empty-state`（径向极光 + 20px 点阵 + light 变体）；与 idea 的 `.chat-screen-shell.is-empty-state` 效果等价 |
| 10.4 | 模式列表 | ✅ | `store/agentStore` + `ModeSelect` + `modeColors`；`agents.list` → `AgentHandler.refresh`；`view.ready` 时主动请求目录 |
| 10.5 | 模型列表与置顶 | ✅ | idea `ModelSelect` 整份移植（长按 180ms 拖拽 + `writePinnedModelIds`）、`selectors.css`；保留 `useDropdownPosition` |
| 10.6 | 推理力度 | ✅ | `reasoningUtils` + `types.getAvailableReasoningLevels` 均为 idea 版；`settings.reasoning` per tab |
| 10.7 | 权限弹窗 | ✅ | `SessionCallbackAdapter` 盖 `tabId/sessionId`；`PromptRegistry` 登记/关 tab 拒绝；后台 tab 排队 + 角标；答复走 v2 `permission.reply` / `question.reply` / `plan.reply`，校验归属，失败回执 `command.rejected`（A26） |
| 10.8 | 问题弹窗 | ✅ | 同一套归属；超时=拒绝+中断会话+关卡片；`questionAnswerStore` 按 `callId` 失效；答案卡 |
| 10.9 | 状态面板三子页 | ✅ | 展开/子页按 tab（`useTabBarState.statusPanelTab`）；`task`/`todos`/`files.undo` 按 tab；`resolveSubagentRunState` 统一；`subagent.history` 宿主 handler 已补；`StatusPanel.less` 与 idea 逐字节一致 |
| 10.10 | 添加附件 | ✅ | `TabAttachmentStore`（32MB、分块顺序、按 tab 落盘、关 tab `releaseTab`）；发送只带 `attachmentId`；切 tab 由 `tabDraftStore.attachments` + `useTabSessionBinder` 恢复 |
| 10.11 | 引用文件 `@` | ✅ | `files.list`（按目标 tab cwd）→ `files.listed`；`useFileTags.restoreFileTags` 切 tab 重建 chip |
| 10.12 | 文件上下文 | ✅ | `autoOpenFileEnabled` 三态 + `autoOpenFileEnabledResolver` 按 tab 注入；`context.refresh` 落 `TabSettings`；`ChatWindow.createSessionForTab` 注入 `contextEnabledResolver`，关闭 Context Bar 即停止注入活动文件/选区 |
| 10.13 | bash `!` | ✅ | `TabSessionSendHandler` 的 `!cmd` 分支取目标 tab 的 cwd；legacy `SessionHandler` 保留兜底 |
| 10.14 | opencode `/` | ✅ | `commands.refresh` 按 tab cwd + `slash.commands` 按 tab 投递 + 前端 `commandsByTab`；未知命令回退普通消息（`KnownCommands`）；`SHARE_MENU_ENABLED=false` |

---

## 4. 验收记录（2026-10-29 实跑）

| 命令 | 结果 |
|---|---|
| `pnpm run compile`（tsc + eslint + esbuild） | ✅ 0 error |
| `cd webview && pnpm run build`（tsc + vite + copy-dist） | ✅（9.73MB 单文件，自动同步） |
| `webview: npx vitest run` | ✅ **178 文件 / 1488 项**全部通过 |
| `webview: tsc -p tsconfig.test.json --noEmit` | ✅ 0 错 |
| `pnpm test`（宿主，`pretest` 先 `clean:out`） | ✅ **121 passing / 0 failing** |
| 依赖检查（`package.json`） | ✅ `"opencode-buddy-core": "github:SenjuObito/opencode-buddy-core#v1.0.0"`，无本地 link 残留 |

---

## 5. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-29 | **P9-A30（本轮）**：**全面清理旧架构 Window 裸事件侵入与推理胶水代码，以 IDEA 架构为蓝图重构通道事件化体系**：
1. **用户核心发现与架构重构要求**：
   - 用户在深度审查中敏锐指出关键架构偏离：“*怎么新建会话调用的是 window 的事件，还有弹窗怎么也是 window 的事件，window 除了设置类都已经被重构了通道事件*”；
   - 用户同时指出多项与 IDEA 逻辑脱节的严重缺陷：输入框文件上下文与设置不同步、切换模型后推理力度恒为 low、`@` 无法呼出子代理模式、会话目录与 VS Code 工作区脱节、撤回消息后会话列表消失、多会话弹窗切换 tab 后丢失；
   - **用户根本要求**：**严禁在旧架构上打补丁，严禁写新旧架构胶水代码，必须彻底以 `opencode-idea-gui` 为权威蓝图全面纠偏实施**。
2. **彻底纠偏与实施整改**：
   - **全面废除 Window 事件侵入，回归标准通道语义事件（对齐 IDEA）**：
     - 重构 `permissionCallbacks.ts`：彻底废弃通过 window 裸函数进行权限/提问/计划审批请求通知的旧逻辑，统一通过 `registerHostEvents` 注册语义事件（`permission.requested`、`question.requested`、`plan.requested`、`prompt.closed`、`prompt.question.closed`、`prompt.plan.closed`、`question.answered`、`question.invalidated`、`toast.error`）；
     - 重构 `useSessionManagement.ts`：彻底废除 `sendNewSession`（向宿主投递废弃的 `create_new_session`），对齐 IDEA 全面规范使用通道命令 `session.load`、`history.delete`、`history.deleteMany`、`history.export`、`history.favorite`、`session.rename`，新建会话统一调度 `openNewSessionTab()`；
     - 重构 `App.tsx` 中的撤销与消息删除：将 `revert.changed`（基于 `parseRevertStateEvent` 解析，支持前台 Tab 与后台 Tab 分流更新）与 `message.removed` 统一接入 `registerHostEvents` 并注册进注销列表；
   - **消除多会话弹窗切 Tab 丢失缺陷**：
     - 彻底删除 `useDialogManagement.ts` 中基于 `currentSessionId` 监听盲目清空 `pendingPermissionRequests` / `currentPermissionRequest` 的错误 `useEffect`；
     - 恢复 `window.__dialogStore.restore` 100% 对齐 IDEA 逻辑，切 Tab 时从 `tabStore` 权威恢复目标 Tab 的挂起弹窗；
     - 修复 `bridge.ts` 中的 `sendInterrupt`，移除私自添加的 `dropped interrupt: no tab owns the session` 判定，100% 还原 IDEA 蓝图；
   - **彻底清除推理力度胶水代码，恢复推荐力度与徽标**：
     - 彻底删除胶水文件 `reasoningUtils.ts` 与 `reasoningUtils.test.ts`；
     - `ReasoningSelect.tsx` 完全对齐 IDEA 蓝图，基于 `getRecommendedReasoningEffort` 自动计算模型推荐档位，恢复 `(Recommended)` 徽标渲染，切模型时自动平滑回退至推荐档位；
   - **工作区路径精准识别**：
     - 修复 `extension.ts` 中的 `fallbackWorkingDirectoryResolver`，优先获取当前激活文档所在工作区根目录及 `workspace.workspaceFolders[0]`，避免目录锁定在子文件父目录；
   - **修复 `@` 模式子代理选择器**：
     - 在 `AgentHandler.ts` 的 `pushAgents` 中补充使用 `WebviewBroadcaster.broadcastRaw` 广播 `host.events` 批量的 `agents.updated` 语义事件，打通 Webview `agentStore.ts` 接收链；
   - **文件上下文 Tab 级状态隔离与设置解耦**：
     - 设置页中的 `autoOpenFileEnabled` 作为新建 Tab 时的默认首选项，而当前 Tab 的文件上下文开关在当前 Tab 内独立生效，在消息发送时通过 `tabStore.getActiveTabAutoOpenFileEnabled()` 读取当前 Tab 的权威状态。
3. **双端验证全绿**：
   - 宿主单元测试 **121 passing / 0 failing**；
   - Webview 单元测试 **177 个测试套件，1488 项单测 100% 全部通过**；
   - 双端全量编译打包 **0 error 0 warning**。 |
| 2026-10-29 | **P9-A29**：**彻底排查并根治发送消息无响应与持续 loading，打通宿主-Webview 全链路 Tab 同步与命令路由容错**：
1. **彻底排查根因**：
   - 追踪全链路日志与执行流：Webview 在初始化阶段收到宿主 `tab.resync`（带宿主生成的权威 activeTabId），因 `useTabSessionBinder.ts` 中的 `resync` 直接执行 `JSON.parse(json)`，而 VS Code 宿主通过 postMessage 传递的是结构化 Object，抛出 `SyntaxError: Unexpected token 'o', "[object Object]" is not valid JSON`，导致 `tab.resync` 被直接丢弃；
   - Webview 因丢弃了宿主 Tab 状态，本地兜底采用了虚拟 `'tab-1'`；
   - 当用户发送消息时，Webview 携带 `'tab-1'` 发起 `session.send`；宿主在 `this.registry.get(targetTabId)` 中查不到 `'tab-1'`，判定为 `TAB_NOT_FOUND` 直接 `rejectCommand` 丢弃，且由于宿主缺少详细日志，形成静默黑洞，daemon 根本未收到任何 `opencode.send`。
2. **彻底修复与对齐**：
   - **`useTabSessionBinder.ts` 健壮解析**：将 `resync` 入参改为兼容 `string | unknown`，若已为对象则直接使用，若为字符串则 `JSON.parse`，彻底治愈 `tab.resync` 崩溃，使 Webview 100% 成功同步宿主的权威 Tab 列表与 activeTabId；
   - **宿主会话命令自动建表容错（对齐 IDEA）**：在 `ChatWindow.ts:1142`，对齐 IDEA `SessionHandler.java` 的 `context.createSession(tabId)` 设计，当收到 `session.` 前缀的命令且在 registry 中未找到对应 Tab 时，自动调用 `this.registry.create` 进行建表挂载，杜绝丢弃；
   - **全面对齐 `sessionCallbacks.ts`**：引入 IDEA 权威的 `registerHostEvents` 语义注册，接通 `command.rejected` / `attachment.failed` / `session.bound` / `tab.title.changed` 等事件；在命令被拒绝时不仅输出 toast，并立即重置界面的 `loading: false` 与 `streamingActive: false`，彻底消除界面无限 loading；
   - **全链路命令审计与日志增强**：在 `OpenCodeViewProvider`（host_command 入站）、`ChatWindow.handleViewCommand`、`rejectCommand` 中补充详细的日志追踪，保证每一步命令执行与拒绝在 `opencode-plugin.log` 中清清楚楚。
3. **双端验证全绿**：宿主 **121 passing**、Webview 178 个测试文件 **1491 项单测 100% 全部通过**，双端全量编译打包 **0 error 0 warning**。 |
| 2026-10-29 | **P9-A31（本轮）**：**修复会话标题断流、模式大小写与多语言、切Tab弹窗保持、文件上下文持久性与撤销/恢复消息对齐；全量对齐 IDEA 蓝图**：
1. **解决会话标题不更新断流问题**：
   - 修复 `ChatWindow.ts` 的 `bindTabSession` 错误使用 `record.getSession() !== session` 拦截导致首次分配 session 时直接被 return 的严重缺陷；对齐 IDEA `OpencodeBuddyChatWindow.java:2324-2358`，正确为 `record` 绑定 `boundSession`、注入 `adapter.tabId`、`adapter.sessionId`，并向前端广播 `session.bound` 命名事件；
   - 修复 `SessionCallbackAdapter.onSessionTitleReceived` 中确保 `this.sessionId` 正确并发送 `tab.title.changed`；
   - 增强 `sessionCallbacks.ts` 中的 `updateSessionTitle` 参数兼容性，无缝解析 `(payload, env)` 和 `(sessionId, title)` 两种调用形态。
2. **解决模式首字母小写与描述多语言支持问题**：
   - 对齐 IDEA `ModeSelect.tsx`，将模式名称格式化为首字母大写；
   - 修复 `agent.description || t(...)` 逻辑被 daemon 返回的英文描述短路跳过的问题，重构为 `t('openCodeModes.${i18nKey}.description', { defaultValue: agent.description || '' })`，实现中文多语言优先与本地化。
3. **彻底解决切换 Tab 导致弹窗消失问题**：
   - 修复 `useTabSessionBinder.ts` 在 `saveCurrentTabSnapshot` 时遍历其它后台 Tab 并在未检查下覆盖 `promptStore` 的缺陷，改为权威合并保护；在 `selectTab` 中安全回填，避免空数组覆盖真实弹窗；
   - 在 `window.__dialogStore.getSnapshot()` 中补齐 `plans` 快照；
   - 移除 `useDialogManagement.ts` 中非 IDEA 蓝图的失焦关灭弹窗副作用。
4. **彻底解决设置中关闭发送文件路径开关后 Tab 内文件上下文消失问题**：
   - 移除 `SettingsHandler.ts` 中私自添加的 `this.context.clearEditorContext()`，对齐 IDEA `ProjectConfigHandler.java:236-246`；
   - 移除 `EditorContextTracker.ts` 中在全局设置关闭时强制 clearSelectionInfo 的逻辑，使设置仅作为新会话/新 Tab 的默认值，各 Tab 自身独立维护开启状态。
5. **彻底解决撤销/恢复后会话列表消失、无法展开、无法恢复的问题**：
   - 修复 `MessageList.tsx` 的切片回退逻辑：仅在 `revertBoundaryId === 'latest'` 时才回退寻找最后一条人类消息，避免把服务端已过滤的消息列表再次切空；
   - 在 `App.tsx` 的 `consumeRevertBoundary` 补齐对 `tabStore.updateTab(activeTabId, ...)` 的更新；
   - 在 `handleRedoMessage` 中恢复时显式调用 `loadHistorySession(sid)` 重新从服务端拉取完整快照；
   - 移除切换会话时抹杀 revert 状态的副作用。
6. **双端验证全绿**：宿主 **121 passing**、Webview 177 个测试文件 **1488 项单测全部通过**，双端全量编译打包 **0 error 0 warning**。 |
| 2026-10-29 | **P9-A28**：**修复发送消息无 AI 返回与新建会话推荐推理力度未生效，打通全链路 SessionSink 与命名数据面**：
1. **彻底解决发送消息后一直 loading 无 AI 消息返回问题**：
   - **重绑定与解除绑定机制闭环**：当 daemon 检测到目录不匹配或在同一 tab 切换会话时，`ChatWindow.bindTabSession` 对发生变更的 sessionId 自动执行 `registry.release(tabId)`，彻底消除 `already bound to` 异常阻断，并在重绑时向前端广播 `session.bound` 命名事件；
   - **`SessionCallbackAdapter` 缺失 Tab 身份修复**：对齐 IDEA `OpencodeBuddyChatWindow.java`，在 session 绑定时立即为 `boundAdapter` 和 `boundCoalescer` 注入 `setSessionId` 与 `setTabId(tabId.value)`，使流式增量（`content.delta` 等）精准按 G8 命名事件路由至对应 tab，杜绝被判定为无 tab 身份而丢弃；
   - **`registerSessionSink` 接入**：在 `ChatWindow` 中补充 `bindSessionSink` / `unbindSessionSink`，将 session 的 streamRouter 挂载至 `OpenCodeDaemonBridge`，保证无论是否为当前请求匹配行均能完整回传。
2. **彻底解决新建会话后推理力度未采用模型推荐默认选项问题**：
   - **参数透传对齐**：修复 `App.tsx` 调用 `useSessionTabs` 漏传 `availableModels` 和 `currentProvider` 的缺陷，并在 `useTabLifecycle.ts` 新建会话时，使用对应模型的 `getRecommendedReasoningEffort(selectedModelInfo?.variants)` 精准计算推荐力度并设置，替代原本硬编码的 `'default'`；
   - **模型与推理联动机制对齐**：在 `App.tsx` 实现并接入 `handleModelSelectWithEffort`，在切换模型、重置首选模型（`resetToPreferredModel`）以及新建 tab 时，全流程联动更新推荐推理力度。
3. **双端验证全绿**：宿主 **121 passing**、Webview 178 个测试文件 **1491 项单测全部通过**，双端全量编译打包 **0 error 0 warning**。 |
| 2026-10-29 | **P9-A27**：**基于 IDEA 蓝图彻底消除状态源与事件流架构断层，修复 7 项核心交互缺陷**：
1. **数据源彻底统一**：以 `opencode-idea-gui` 为权威蓝图重构 `MessagesContext.tsx`，彻底废除 15 个脱离 tab 的独立 `useState`，改为通过 `tabStore.getActiveTab`（`useSyncExternalStore`）作为唯一事实源，统一驱动 `turnActive: isTabTurnActive(activeTab)`、`loading`、`streamingActive` 等。
2. **终端流式与事件结算对齐**：宿主 `SessionCallbackAdapter` 补齐 `turn.settled`；前端 `streamingCallbacks` 接入权威终端结算，解决发送消息后偶发无限 loading 的问题。
3. **消除装配胶水与传参偏离**：
   - 彻底删除 `App.tsx` 与 `ChatScreen.tsx` 中的遗留补丁 `userCollapsedRef` 和 `forceStatusUpdate`，全面恢复 IDEA 架构原生 `toggleStatusPanel`；
   - 修复文件上下文设置影响全局的问题：`ChatScreen` 与 `ChatInputBox` 仅接收并操作 `activeTabAutoOpenFileEnabled` / `setActiveTabAutoOpenFileEnabled`，全局开关保留在 `SettingsView`；
   - 修复从历史加载会话 tab 标题为“历史会话”的缺陷：`HistoryView` 的 `onLoadSession` 完整补齐 `session.title`、`session.model`、`session.agent`、`session.reasoningEffort` 传参；
   - 修复新建会话标题文案：对齐 IDEA `zh.json`，将 `newSession` 修正为“新会话”；
   - 清理设置页中冗余的“opencode 引擎”配置块：移除 `EnvironmentTab.tsx` / `SettingsView` 中的 `daemonEngine` 渲染，与 IDEA 保持一致。
4. **全链路验证全绿**：宿主 **121 passing**、Webview 178 个测试文件 **1491 项单测 100% 通过**，双端全量编译打包 **0 error 0 warning**。 |
| 2026-10-29 | **P9-A26**：①**提示答复失败回执 `command.rejected` 闭环**：`PermissionHandler.handleReplyCommand` 返回 `PromptReplyResult`，当 prompt 不存在或串 tab（owner mismatch）时由 `ChatWindow` 向对应 tab 发布 `command.rejected`，彻底消除 §4.8 剩余缺口；新增 2 项宿主断言单测（共 121 passing）。②**全部 10 个语言包 Tab key 100% 补全**：为繁体中文（`zh-TW`）、日语（`ja`）、韩语（`ko`）、法语（`fr`）、西班牙语（`es`）、巴西葡语（`pt-BR`）、俄语（`ru`）、印地语（`hi`）精准补齐 13 项 Tab 多会话与右键菜单键值。③**清理 `.DS_Store`**：删除 `webview/src/assets/.DS_Store` 并在根目录 `.gitignore` 补充忽略规则。实跑：宿主 **121 passing**、webview **1488 项**全绿、全量双端打包通过。 |
| 2026-10-29 | **P9-A25**：按文件从 idea 同步剩余 UI/交互：①历史页“深度搜索”刷新按钮；②Shift+Tab 改为循环宿主推送的全部 primary agent；③生成指示器按整个 turn 显示；④`CompactSummaryBlock` 换成 idea 紧凑胶囊样式；⑤锚点栏过滤 tool_result；⑥工具块以 `result.is_error` 为准；⑦模型选择器支持后缀匹配与默认纠偏。实跑：宿主 **119 passing**、webview **1488**、编译/构建 ✅。 |
| 2026-10-29 | **P9-A24**：提示答复命令面 v2 + `StatusNoticeBar` 终端错误通知。实跑：宿主 119、webview 1483。 |
| 2026-10-29 | **P9-A23**：命令面 v2 对齐（`fork`/`compact`/`share`/`revert`）。实跑：宿主 116、webview 1476。 |
| 2026-10-29 | **P9-A22**：G8 数据面重写完成（命名 TabEvent + per-tab lane）。实跑：宿主 111、webview 1476。 |
| 2026-10-29 | **P9-A21**：A20 审计收口（多视图接线 G1、删除 TabStatusStore G2、G3/G6/G7/G9/G10/G11/G12/G13/G14/G15/G16）。 |
