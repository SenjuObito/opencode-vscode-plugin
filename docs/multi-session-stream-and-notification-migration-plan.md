# 多会话 / 消息流 / 通知 —— idea-gui → vscode-plugin 迁移方案

> 目标仓库：`opencode-vscode-plugin`
> 参考仓库：`opencode-idea-gui`（同级目录 `../opencode-idea-gui`）
> 撰写时间：2026-10-19。本文只给方案与落点。
> **实施状态（2026-10-19）**：P0–P4 已完成，实际改动与验证见
> `docs/multi-session-stream-and-notification-implementation.md`；P5 未做。
> 口径：除「设置持久化 / JCEF / IntelliJ API」外，其余按 idea 语义同步；平台差异处显式标注改写方式。

---

## 0. 结论先行

1. **九个域里，真正的结构性缺口只有两个**：**会话水化（hydrate）+ 服务端对账（reconcile）**、**tab 持久化**。其余七个域要么已同步，要么只差几处接线。
2. **最紧急的不是缺功能，是协议漂移**。宿主已按 `(sessionId, payload)` 双参下发，而 webview 的 `onTaskEvent` / `onTodoUpdated` / `onMessagesRemoved` 仍按单参解析 —— 三条推送当前在 `JSON.parse(sessionId)` 阶段抛错并静默吞掉。这属于 P0，且**不是本轮迁移引入的**，是历史漂移。注意：`onMessagesRemoved` 在 idea 侧同样是单参，属于**双端同源缺陷**，不能照抄。
3. vscode 比 idea 多一层标签：**原生编辑器标签（每 panel 一个 ChatInstance）** + **webview 内标签（同一 ChatInstance 内多 session）**。所有「切换 tab」的方案必须区分这两层，idea 只有后者。
4. 分五个阶段：P0 协议修补（小）→ P1 水化/对账（主体）→ P2 tab 与前后台（主体）→ P3 历史加载收口 → P4 通知语义 → P5 渲染健壮性（可选）。

### 现状速览

| 域 | 判定 | 说明 |
|---|---|---|
| 多会话（宿主骨架） | 已同步 | `SessionManager` 已支持后台会话并发、`ensureSessionForTab`、`inheritConfigFrom`，切会话不 dispose 旧会话 |
| 消息流（通道） | 已同步 | `SessionCallbackAdapter` 全量双参下发；`StreamMessageCoalescer` / `StreamDeltaThrottler` / `sequenceBarrier` 均在位 |
| 消息流（webview 分发） | **部分 / 有缺陷** | 三条回调单参 → 实际失效；后台 delta 丢 `raw` |
| 切换 tab | **部分** | 视图内 tab 状态切换完整；缺 hydrate、缺持久化 |
| 前后台切换 | **缺失** | 无 `onDidChangeViewState`；无「重新可见时对账」 |
| 前后端验证消息 | **部分** | 有 sessionId/seq 屏障，无回调 arity 契约与代际校验 |
| 历史消息加载 | 基本可用 | `load_session` + `fetchAndRestoreMessages` 已在；缺 count 回执、缺 reconcile |
| 任务通知 | **部分** | 链路通，但无会话上下文、无跳转；后台会话记错 model |
| 声音播放 | 已同步 | `notificationSound.ts` 两仓逐字节相同；宿主侧 gate 已实现（`vscode.window.state.focused`） |

---

## 1. P0 — 协议漂移修补（先做，否则后续调试全被污染）

### P0-1 三条回调按双参解包

宿主侧（已双参，不用改）：

| 回调 | 落点 |
|---|---|
| `onTaskEvent` | `src/host/session/SessionCallbackAdapter.ts:415` |
| `onMessagesRemoved` | `src/host/session/SessionCallbackAdapter.ts:442` |
| `onTodoUpdated` | `src/host/session/SessionCallbackAdapter.ts:452` |

webview 侧（单参，需改）：

| 文件 | 行 | 现状 | 改法 |
|---|---|---|---|
| `webview/src/hooks/windowCallbacks/registerCallbacks.ts` | 166 | `(eventJson: string)` | `(arg0, arg1?) =>`，`arg1 ?? arg0` 取 payload；有 id 时走 `resolveSessionId` |
| 同上 | 199 | `(payload: string)` | 同上；把 `JSON.parse` 移进 try 且先解包 |
| `webview/src/App.tsx` | 699 | `(json: string)` | 同上（`onMessagesRemoved` 必须是双参，idea 侧同样要修） |
| `webview/src/global.d.ts` | 163/168/307 | 163、168 已声明双参 | 307 补成 `(arg0: string, arg1?: string)` |

统一写法（与 `historyLoadComplete` 现有兼容策略一致）：

```ts
const unwrap = (arg0: string, arg1?: string) =>
  typeof arg1 !== 'undefined' ? { sessionId: arg0, payload: arg1 } : { sessionId: null, payload: arg0 };
```

**验收**：`onTaskEvent` 收到 `('ses_x', '{"toolUseId":...}')` 时能更新 `taskEvents`；`onTodoUpdated` 能写入 `sseTodos`；`message.removed` 能让对应消息从列表消失（当前 revert 后仍需等全量快照）。

### P0-2 后台会话 delta 维护 `raw`

- 落点：`webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts:479-520`
- 现状：后台 tab 累加只写 `content`，不写 `raw.message.content[last].text`。前台分支（同文件）是两者都写。
- 后果：切回后台正在流式的 tab，`getContentBlocks` 拿不到 raw 文本块，markdown / 工具块渲染退化，或整段文本被当成 fallback。
- 改法：把前台分支的 raw 累加逻辑抽成 `appendDeltaToMessage(message, delta)`，两侧共用；新建消息时同样构造 `raw = { type:'assistant', message:{ content:[{type:'text',text:delta}] } }`（idea 版即此实现）。

### P0-3 会话切换前归档流式 runtime

- idea：`webview/src/hooks/windowCallbacks/registerCallbacks.ts:84-90` 传入 `onBeforeResetTransientState: () => window.__sessionTabsStore?.archiveActiveStreamingRuntime?.()`。
- vscode：`sessionTransition.ts:46/84` 已支持该钩子，`useSessionTabs.ts:561` 已实现 `archiveActiveStreamingRuntime`，但 **`registerCallbacks.ts` 没接线** —— 能力齐全，只差一行。
- 后果：离开正在流式的会话时 `turnId` / `streamingContentRef` / accumulator 被 `resetTransientUiState` 清掉；切回后要么渲染上一会话残留文本，要么 turn 结束事件对不上。
- 改法：照 idea 补 `onBeforeResetTransientState`，并在单测里断言「切走后 runtimeSnapshots 有键、切回能恢复」。

### P0-4 回调 arity 契约测试

新增 `webview/src/hooks/windowCallbacks/__tests__/callbackArity.test.ts`：维护一张 `{回调名: 期望参数个数}` 表，与宿主 `SessionCallbackAdapter` 的调用点对齐（可用正则扫源码断言，或人工维护清单 + 常量）。目的：防止下一次「宿主加首参、前端忘改」再次静默失效。

---

## 2. P1 — 会话水化与服务端对账

这是 idea 与 vscode 最大的结构性差异：**idea 认为「视图是宿主状态的投影」，vscode 目前认为「视图自己持有消息」**。

### 2.1 宿主：`loadFromServer` / `reconcileWithServer`

参考：`opencode-idea-gui/src/main/java/com/opencodebuddy/session/SessionMessageOrchestrator.java:143-196`（load）与 `:209-...`（reconcile）。

落点：`src/host/session/OpenCodeSession.ts`，新增两个方法：

```ts
async loadFromServer(): Promise<void>   // 清空后全量装入；失败要 reject（不能吞成"成功但为空"）
async reconcileWithServer(): Promise<boolean>  // 非破坏性：仅在 idle、服务端消息更多或末条不同时替换
```

数据源复用现有 `daemon.listMessages`（`HistoryHandler.fetchAndRestoreMessages` 已在用，见 `HistoryHandler.ts:373` 起），解析复用 `SdkMessageConverter.convertSdkMessages`。

必须遵守 idea 的三条硬约束：

1. `state.isBusy()` 时直接返回，不做任何替换；
2. 服务端返回空 + 本地有消息 → 保持本地（`reconcile` 不动作）；
3. `loadFromServer` 失败或「成功但空」必须可被调用方识别，用于重试 / 解除绑定，避免「绑着 sessionId 却没有消息」的幽灵态（`OpencodeChatWindow.java:1855-1894` 的教训）。

### 2.2 宿主：`hydrateSessionToWebview`

参考：`OpencodeBuddyChatWindow.java:1736-1759`。

落点：`src/host/session/OpenCodeSession.ts`（或 `SessionManager`）：

```
packet = {
  sessionId, isStreaming: state.isBusy(), loading: state.isLoading(),
  revertBoundaryId: state.getRevertState()?.messageID,
  messages: MessageJsonConverter 转换后的数组
}
callJavaScript('onSessionHydrated', JSON.stringify(packet))
```

注意 vscode 的通道已是 `callJavaScript(fn, ...args)` → `postMessage({type, args})`，所以这里是**单参**（整个 packet 一个 JSON），不能照抄 Java 的 `callJavaScript("onSessionHydrated", packet.toString())` 再让前端按双参解 —— 保持单参最简洁，与 `applyBackendTabState` 一致。

### 2.3 宿主：什么时候 hydrate

| 触发 | 动作 |
|---|---|
| `switch_session`（视图内切 tab） | 先 `switchToSession`，若 `!busy` 则 `await reconcileWithServer()`，然后 `hydrateSessionToWebview` |
| 原生 panel 重新可见（见 P2-1） | 同上 |
| 后台会话 turn 结束 | 不 hydrate（视图不在前台），交由 `onTurnEnd` 更新后台快照 |
| `frontend_ready` 且视图为空 | 见 P2-3 |

### 2.4 webview：`onSessionHydrated`

参考实现：idea `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts:1358-1435`，逐段移植到同名文件。

语义（照抄，不要简化）：

- `targetSessionId` 缺失或 `messages` 非数组 → 直接 return；
- 前台（`activeSessionId` 相同或为空）→ `setMessages(authoritative)`，重置 `__messageBaseIndex` / `__opencodeListStart`；按 `isStreaming` 同步 `isStreamingRef` / `setStreamingActive`，流式中取最后一条 assistant 作为 `streamingMessageIndexRef`；
- 同步 `loading` / `status` / `revertBoundaryId`（`revertBoundaryId` 走 `onRevertStateUpdate(sessionId, ...)`）；
- **无论前后台**都写 `__sessionTabsStore.updateBackgroundTab`，保证后台 tab 快照与宿主一致。

### 2.5 验收

- 两 tab（A 流式中，B 空闲）：切到 B 再切回 A，A 文本不串、spinner 仍转、turn 结束后正常收尾。
- A 空闲时在服务端侧新增消息（另一窗口发送）→ 切回 A 能看到新消息。
- 断网 / serve 未就绪时切 tab：不出现空白对话 + 旧对话「诈尸」，要么重试成功要么明确报错。

---

## 3. P2 — 切换 tab 与前后台

### 3.1 原生 panel 重新可见 → 对账

参考：`OpencodeBuddyToolWindow.java:307-323`（`selectionChanged` → `onTabActivated()` + `resyncSessionFromServerIfNeeded()`）。

落点：`src/host/tabs/TabManager.ts:120` 创建 panel 后补：

```ts
panel.onDidChangeViewState((e) => {
  if (!e.webviewPanel.visible) return;
  const session = tab.instance.sessionManager.getActiveSession();
  void resyncSessionFromServerIfNeeded(tab, session);  // 空视图 + idle 才 load，带 3 次退避
});
```

`resyncSessionFromServerIfNeeded` 直接移植 `OpencodeBuddyChatWindow.java:1825-1894` 的判据：

- 前置：`sessionId` 非空、`!busy`、`!loading`、`messages.length === 0`；
- 失败或空结果重试 3 次（600ms 间隔）；
- 重试用尽仍未拿到 → 解除 sessionId 绑定（`resetSession()`），绝不留幽灵会话。

`onTabActivated` 的语义在 vscode 退化为「无需 repaint」，`forceWebviewRepaint` 保留但只在需要时调用（当前 `sessionTransition.ts:121` 已在用）。

### 3.2 tab 持久化

参考：`settings/TabStateService.java`（tab 名称 + `tabIndex → {sessionId}` 绑定），`TabSessionRestorePolicy.java`（判据只有「已绑定会话」+「前端就绪」）。

落点：新建 `src/host/tabs/TabStateStore.ts`，用 `context.workspaceState`：

```
opencode.tabs           → Array<{ tabId, title, sessionId | null, active }>
opencode.tabs.activeId  → string
```

写入时机：tab 新建 / 关闭 / 绑定 session / 标题变更 / 激活切换。恢复：`activate()` 时逐个 `spawnTab`，已绑定 session 的 tab 在 `frontend_ready` 后走 2.3 的 hydrate。

**注意**：不要把 idea 的 `tabIndex` 当主键 —— vscode 的原生 panel 关闭会重排索引，必须用稳定 `tabId`。

### 3.3 `frontend_ready` 语义统一

现状冲突：

- vscode `WindowEventHandler.ts:219-270` → `session.reconcileWithFreshView()`（`OpenCodeSession.ts:398`）：单视图时**直接 reset 成新会话**；
- idea `OpencodeBuddyChatWindow.java:1825`：空视图时**从服务端恢复**同一会话。

两条语义不能并存。建议（需确认）：

- **侧边栏视图**（`OpenCodeViewProvider`）：保持现状「新视图 = 新会话」，因为它是常驻入口，用户点开就是要新对话；
- **原生 panel + 已绑定 sessionId**：走 resync（不 reset），否则窗口重载后 3.2 的恢复等于白做。

即：`reconcileWithFreshView` 增加一个「是否允许恢复」参数，由调用方（视图类型）决定。

### 3.4 视图内 tab 切换的其余状态

已同步，无需改动（核对后确认）：

- 附件不因切 tab 丢失：`useResetAttachmentsOnSessionChange.ts` 的 `prevTabIdRef` 守卫；
- 弹窗：`window.__dialogStore?.clearActive?.()`；
- model/mode/effort：带 `sessionId` + `silent` 路由；
- 计时 / usage：`turnStartedAt` 按 tab 存取。

---

## 4. P3 — 历史消息加载收口

### 4.1 `historyLoadComplete` 带上 (sessionId, count)

- idea：`SessionLifecycleManager.java:287` 传 `(sessionId, String.valueOf(messageCount))`；webview 用 count 做快照对账，避免「先渲染半截、快照再补齐」的闪烁。
- vscode：`HistoryHandler.ts:307/337/384/516/583`、`SessionManager.ts:165`、`WindowEventHandler.ts:189` 全部**裸调用**（无参数）。
- webview 侧 `messageCallbacks.ts:1154` 已经写好双形态解析（`arg1` 有值时按 `(sessionId, count)`），但宿主从不传，等于死代码。
- 改法：所有宿主调用点补 `(sessionId, String(count))`；`expectedMessageCount` 取本次 `restoreMessages` 实际推送条数。

### 4.2 失败与解绑

`HistoryHandler.fetchAndRestoreMessages` 失败路径当前只 `addErrorMessage`，仍保留 sessionId 绑定。移植 idea 的收尾：重试用尽 → `session.resetSession()` + `setSessionId(null)`，避免用户下一条消息追加到旧会话。

### 4.3 分页

`load_earlier_messages` / `set_earlier_cursor` 在 vscode 已有 handler；本轮不扩大范围，仅回归验证「切 tab 后 cursor 不串会话」。

> 注意：`HistoryHandler.ts` 与 `useHistoryLoader.ts` 是当前进行中的改动，本阶段只做增量补丁，不做整文件覆盖。

---

## 5. P4 — 任务通知

### 5.1 通知带会话上下文

参考：`notifications/OpencodeNotifier.java:54-83`（标题）、`:95-132`（摘要）。

- 标题：`【{session.summary || sessionId}】任务已完成`，无 summary 时退化为纯文案；
- 正文：最后一条 assistant 消息的**最后一个 text block**（工具轮次里 `content` 会拼进工具调用前的说明文字，必须取 raw 的最后一个 text 块），折叠换行/代码围栏，截断到 ~220 字符；
- 落点：`src/host/notifications/NotificationService.ts:30-45`，新增 `buildTitleFromSession(session)` / `buildPreviewFromSession(session, fallback)`；`onTurnCompleted` 的入参已带 `sessionId`，用它取对应 session。

### 5.2 点击通知跳转到对应会话

vscode 的 `showInformationMessage` 只能内联按钮，不能绑定点击回调到具体会话。方案：

- 通知带一个 action「查看」，`then` 里 `WebviewBroadcaster.broadcastJavaScript('focus_session', sessionId)`；
- webview 侧新增 `window.focus_session = (sessionId) =>` —— 在 `__sessionTabsStore` 里按 sessionId 找 tab，找到就 `selectTab`；找不到就忽略；
- 同时 `TabManager.reveal(sessionId)`：遍历 tabs，命中的 `panel.reveal()`（需新增 `sessionId → tabId` 索引，现在只有 `tabId`）。

### 5.3 后台会话记录 model 的错误

`src/host/session/ChatInstance.ts:140-146`：

```ts
const active = sessionManager.getActiveSession();
historyHandler.recordSession(info.sessionId, info.title, info.messageCount, active.state.getModel());
```

后台会话完成时，记的是**当前前台会话**的 model。改为 `sessionManager.getSession(info.sessionId)?.state.getModel()`，取不到再回退 active。

### 5.4 声音

已对齐，**本阶段不改**：

- 播放器两仓相同（`webview/src/utils/notificationSound.ts`，182 行，逐字节一致）；
- 宿主 gate 已按 `vscode.window.state.focused` 实现（`NotificationService.ts:109-148`）；
- 设置页试听按钮已存在（`BehaviorTab.tsx:69/484`）。

唯一差异是 idea 用 Java `AudioSystem` 直放、vscode 用 WebAudio，属平台差异，不迁移。

---

## 6. P5 — 渲染健壮性（可选，建议同批）

| 项 | 参考 | 落点 | 价值 |
|---|---|---|---|
| 消息区错误边界 | `components/MessagesErrorBoundary.tsx`（idea 独有） | `ChatScreen.tsx:253` 包住 `MessageList` | 单条消息渲染崩溃不再白屏整页 |
| `aborted` 中性提示 | idea `ContentBlockRenderer.tsx` + `messageUtils.ts` | 同名文件 | 「用户停止」不再渲染成错误气泡 |
| `questionCard` 结构化渲染 | idea `ContentBlockRenderer.tsx:tool_use` 分支 | 同上 | AskUserQuestion 历史回放可读 |
| v2 subagent 工具名 | idea `useSubagents.ts` 的 `AGENT_TOOL_NAMES` / `readAgentType` | 同上 | v2 的 `subagent` 工具能进子代理列表 |

---

## 7. 明确不迁移（平台差异）

| idea 实现 | 原因 | vscode 等价 |
|---|---|---|
| `WebviewEventQueue` 的 JS 字符串拼接 / 批量执行 / 引号转义 | `postMessage` 是结构化消息，无 JS 字面量注入问题 | 保留 `StreamMessageCoalescer` 的合并与节流即可 |
| `MessageDispatchGate` 的 dispose 竞态 | 无 EDT/JCEF 双线程模型 | `channel.isDisposed()` + 新增 `viewGeneration` 校验（见下） |
| `SurfaceFrameFence` / `surface_damage` / `__requestSurfaceRepublish` | JCEF OSR 专有 | `forceWebviewRepaint`（已存在，按需调用） |
| `IdeFocusState`（AWT `KeyboardFocusManager`） | 无 AWT | `vscode.window.state.focused` |
| `TabStateService`（`PersistentStateComponent`） | 无 IntelliJ 持久化 | `workspaceState`（见 3.2） |
| `SoundNotificationService`（Java `AudioSystem` / JLayer） | 无桌面音频栈 | WebAudio（已实现） |

**代际校验（补 idea 的 pageGeneration 语义）**：`SingleWebviewChannel` 加一个 `generation`，webview 每次 `frontend_ready` 带 `generation` 回传；宿主对「旧代际的迟到消息」直接丢弃。当前只靠 `disposed`，无法覆盖「webview 重载但 panel 未销毁」的窗口。

---

## 8. 测试计划

| 层 | 新增 | 命令 |
|---|---|---|
| 宿主 | `hydratePacket.test.ts`（字段完整、revertBoundaryId 映射）、`reconcile.test.ts`（idle/忙碌/空返回三分支）、`resync.test.ts`（3 次退避 + 解绑）、`tabStateStore.test.ts` | `pnpm run compile` + `vscode-test` |
| webview | `onSessionHydrated.test.ts`（前台/后台/revert）、`callbackArity.test.ts`、`backgroundDeltaRaw.test.ts`、`runtimeArchive.test.ts` | `cd webview && pnpm test` |
| 手动 | 见下 | — |

手动验收清单：

1. 两个视图内 tab 同时流式，互不串字；切走再切回，spinner / 计时 / 文本一致。
2. 原生 panel A 流式中切到 panel B，再切回 A，输出连续无断层。
3. 停止 A：A 的 spinner 立刻停，B 不受影响。
4. 窗口重载：tab 列表恢复，已绑定会话能自动拉到历史（P3 后）。
5. 后台会话完成：通知标题带会话名，点「查看」跳到对应 tab。
6. 关闭声音开关 / 开启「仅未聚焦时」：图标在任务栏时响，聚焦时不响。
7. `message.removed`：revert 后消息立即消失，不需要等下一条消息。
8. 子代理：task 进度事件能在后台 tab 上继续累积（P0 修复后）。

---

## 9. 顺序与风险

```
P0（0.5d）→ P1（2-3d）→ P2（2d）→ P3（1d）→ P4（1d）→ P5（1-2d，可选）
```

| 风险 | 缓解 |
|---|---|
| P0 修复后暴露别的问题（此前被静默吞掉） | 先只改解包、不改业务分支；用日志确认收到 payload 再动逻辑 |
| `frontend_ready` 语义改动影响侧边栏 | 按视图类型分流（3.3），侧边栏保持现状 |
| hydrate 覆盖用户在视图内的临时状态（滚动位置/展开态） | hydrate 只替换 `messages`，不动 UI 局部状态；`expandedState` 按 messageId 保留 |
| tab 持久化 + 多 panel 引起重复 spawn | 恢复时先按 `tabId` 去重，且 `activate` 只跑一次（`ExtensionContext.globalState` 存 `restored` 标记） |
| reconcile 与流式竞争 | 复用 idea 的「busy 前判 + 替换前再判」双重检查 |

---

## 10. 待确认

1. `frontend_ready` 对**原生 panel** 是否允许恢复（3.3）—— 建议允许，否则 tab 持久化无意义。
2. 通知点击跳转是否要做（5.2）—— 需要新增 `sessionId → panel` 索引，属于小改但会动 `TabManager` 公开接口。
3. P5 是否本批做（`MessagesErrorBoundary` + `aborted` + `questionCard` + v2 工具名）—— 与本次九域强相关，建议同批。
