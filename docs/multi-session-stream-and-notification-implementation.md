# 多会话 / 消息流 / 通知 —— 实施记录

> 配套方案：`docs/multi-session-stream-and-notification-migration-plan.md`
> 实施时间：2026-10-19。本文记录**实际改动**、刻意偏离 idea 的地方、验证结果与遗留风险。
> 口径：除「设置持久化 / JCEF / IDEA API」外按 idea 语义同步；平台差异处给等价实现。

> **架构修订（同日）**：本文 P0–P4 落地时仍是「一个视图一个 `ChatInstance`」。
> 随后架构收敛为**单实例 + 多视图**，相关实现以 `docs/multi-tab-and-session-isolation.md` 为准。
> 差异点：
> - `viewKind`（侧边栏重置 / panel 恢复）已删除，`frontend_ready` 一律只补水化、不重置会话；
> - `TabStateStore`（panel → sessionId 持久化）已删除，改为 `ChatTabStore`（全局标签列表持久化）；
> - `hydrateSessionToWebview` 的广播范围改为「默认全体、`origin: true` 时定向」；
> - 通知 / 声音不再需要跨实例去重（单实例天然只触发一次）。

---

## 0. 一句话结论

方案里的 P0–P4 已全部落地。核心变化是把「视图自己持有消息」改成「视图是宿主状态的投影」：
宿主新增 `loadFromServer` / `reconcileWithServer` / `hydrateSessionToWebview`，前端新增
`onSessionHydrated`，切 tab、panel 重新可见、窗口重载三条路径都走同一套对账 + 水化。

同时修掉了三条**长期静默失效**的回调（宿主早就双参下发，前端仍按单参解析，`JSON.parse(sessionId)`
抛错被 catch 吞掉）：子代理 task 事件、SSE todo、`message.removed`。

---

## 1. P0 协议漂移

### 1.1 三条回调解包

| 文件 | 改动 |
|---|---|
| `webview/src/hooks/windowCallbacks/registerCallbacks.ts` | `onTaskEvent` / `onTodoUpdated` 改为 `(arg0, arg1?)`，`arg1` 存在时取 payload，否则整包兼容旧形态 |
| `webview/src/App.tsx` | `onMessagesRemoved` 同样双参解包 |
| `webview/src/global.d.ts` | `onMessagesRemoved` 声明改为 `(arg0, arg1?)` |

顺带把 idea 的后台语义搬过来（vscode 此前完全没有）：

- `onTaskEvent`：目标会话不是前台时写 `updateBackgroundTab(t.taskEvents)`，不再污染当前标签；
- `onTodoUpdated`：同样按会话路由；payload 兼容 `sessionID` / `sessionId` 两种键，并做 `normalizeTodoStatus` 归一；
- `onMessagesRemoved`：后台会话的删除落到该 tab 的 `messages`，不动前台列表。

### 1.2 后台 delta 维护 `raw`

`streamingCallbacks.ts` 后台分支此前只累加 `content`，不写 `raw.message.content[last].text`。
切回正在流式的后台 tab 时 `getContentBlocks` 拿不到文本块，markdown / 工具块渲染退化。
现已与前台累加器一致：追加到最后一个 text 块，新建消息时同时构造 `raw`。

### 1.3 会话切换前归档流式 runtime

`registerCallbacks.ts` 补上 `onBeforeResetTransientState`（`sessionTransition.ts` 与
`useSessionTabs.archiveActiveStreamingRuntime` 早已具备，只差这一行接线）。
离开流式会话不再丢 accumulator / turnId。

### 1.4 契约测试

新增 `webview/src/hooks/windowCallbacks/__tests__/callbackArity.test.ts`：

- 扫描宿主 `SessionCallbackAdapter.ts` 的 `callJavaScript('<name>', ...)` 实参个数；
- 扫描 webview 侧 `window.<name> = (...) =>` 的形参个数；
- 多参回调若前端形参更少即失败；`(...args)` 视为不限；
- 另有一张显式清单盯住 5 个会话级回调必须双参。

另有 `callbackRouting.test.ts`：后台 task / todo 落到正确 tab、单参旧形态仍可用。

---

## 2. P1 水化与对账

### 2.1 宿主 `OpenCodeSession`

| 方法 | 语义 |
|---|---|
| `loadFromServer()` | 全量装入；**失败 reject**，成功但为空是合法结果（由调用方判断） |
| `reconcileWithServer()` | 空闲 + 服务端更多/末条不同才替换；服务端空或本地更全时保持本地；拉取期间变忙则丢弃 |
| `hydrateSessionToWebview()` | 下发 `{ sessionId, isStreaming, loading, revertBoundaryId?, messages }`，**单参** JSON |
| `notifyHistoryLoadComplete()` | 统一带 `(sessionId, count)` |
| `notifyMessageLoadFailure()` | 明确告知失败并提示旧会话仍在历史里 |

配套：`SessionState.replaceMessages()` 原子替换（避免「已清空、尚未装入」的空窗）。

对账复用 `ListMessagesCollector` + `convertSdkMessages`，与 `HistoryHandler` 同一数据源。

### 2.2 前端 `onSessionHydrated`

`messageCallbacks.ts` 逐段移植 idea：

- 包不合法（缺 sessionId 或 messages 非数组）直接 return，绝不误清列表；
- 前台：整份替换 `messages`，`__messageBaseIndex` / `__opencodeListStart` 归零，同步
  `isStreaming` / `loading` / `status`，流式中把最后一条 assistant 设为 streaming 目标；
- `revertBoundaryId` 走既有的 `onRevertStateUpdate(sessionId, json)`；
- **前后台都写** `updateBackgroundTab`，保证后台 tab 快照与宿主一致。

### 2.3 触发时机

| 触发 | 动作 |
|---|---|
| `switch_session` | `hydrate` → 空闲时 `reconcileWithServer` → 有变化再 `hydrate` |
| panel 重新可见 | `resyncSessionFromServerIfNeeded`（见 3.1） |
| `frontend_ready`（panel） | `hydrate`；宿主内存为空则 resync |
| 会话流式中切 tab | **不水化**（见 5.1） |

---

## 3. P2 前后台切换与持久化

### 3.1 重新可见 → resync

新增 `src/host/session/SessionResync.ts`（idea `resyncSessionFromServerIfNeeded` 的移植）：

- 前置：`frontendReady` + 有 sessionId + `!busy && !loading && messages.length === 0`；
- 失败与「成功但为空」都重试，3 次 / 600ms；
- 用尽 → `resetSession()` 解绑 + `addErrorMessage`，绝不留幽灵会话；
- 同会话并发调用去重（`WeakSet`）。

接线两处：`TabManager` 的 `panel.onDidChangeViewState`（可见才触发）、
`WindowEventHandler.handleFrontendReady`（panel 且宿主无消息）。

### 3.2 tab 持久化

新增 `src/host/tabs/TabStateStore.ts`，键 `opencode.tabs`，记录
`{ tabId, title, sessionId, active }`，只保存**绑定过会话**的标签。

- 写：新建 / 关闭 / 每次 dispatch 后（绑定真实 sessionId、标题变更都在这条通道里）；
- 读：`TabManager` 构造时读入 `pendingRestore`，由
  `registerWebviewPanelSerializer('opencode-buddy.tab')` 在 VS Code 归还 panel 时按 FIFO 认领；
- 主键用 `tabId` 而非 idea 的 `tabIndex`：原生 panel 关闭会重排索引。

### 3.3 `frontend_ready` 分流

`HandlerContext` 新增 `viewKind: 'sidebar' | 'panel'`：

- 侧边栏：保持「新视图 = 新会话」（`reconcileWithFreshView()` 原语义）；
- panel：`reconcileWithFreshView({ allowRestore: true })`，有 sessionId 时只补推快照不清空，
  随后 `hydrateSessionToWebview()`；宿主为空再 resync。

---

## 4. P3 / P4

### 4.1 历史加载收口

所有 `historyLoadComplete` 调用点带 `(sessionId, count)`：`HistoryHandler`（4 处）、
`SessionManager.createNewSession`（`'0'`）、`OpenCodeSession.notifyHistoryLoadComplete`。

失败路径（重试用尽）此前只 `updateStatus` 仍保留绑定，现在会 `resetSession()` 解绑 + 明确报错。

### 4.2 通知

`NotificationService`：

- 标题：`【会话摘要或 sessionId】任务已完成`（无名称退化纯文案）；
- 正文：最后一条 assistant 消息的**最后一个 text block**，折叠代码围栏与换行，截断 220 字符；
- 动作「View」→ `context.focusSession(sessionId)`：先 `TabManager.revealSession`（reveal panel +
  推 `focus_session`），没有 panel 时退回本视图内切换；
- 前端 `window.focus_session` → `__sessionTabsStore.focusSession`（按 sessionId 找 tab 并 `selectTab`）。

后台会话记错 model 已修：`ChatInstance.onTurnCompleted` 改为
`sessionManager.getSession(info.sessionId) ?? getActiveSession()`。

声音未改（两仓播放器一致，宿主 gate 已在 `vscode.window.state.focused` 上）。

---

## 5. 刻意偏离 idea 的地方

1. **流式中切 tab 不水化**：idea 的宿主是消息的投影中心，水化安全；vscode 的实时文本由视图的
   accumulator 持有，宿主 state 可能差一拍，整份替换会吞掉半截输出。改为依赖视图快照 +
   归档运行时，空闲后才水化。
2. **`hydrate` 用单参**：vscode 通道是 `postMessage({type, args})`，整包一个 JSON 最简洁；
   idea 走 JS 字符串拼接才需要额外区分。
3. **tab 主键用 `tabId`**：见 3.2。
4. **恢复走 `WebviewPanelSerializer`**：不在 activate 时凭空 spawn 面板，避免用户重启后被弹出一堆窗口。

---

## 6. 验证

| 层 | 结果 |
|---|---|
| 宿主 `tsc --noEmit` / `eslint src` | 通过 |
| 宿主 `vscode-test` | **63 passing / 0 failing**（新增 14 条：水化包、对账 4 分支、resync 5 分支、TabStateStore 2、通知摘要 4） |
| webview `tsc --noEmit` | 通过 |
| webview `vitest`（`__tests__` + 会话标签 2 个套件） | **125 passing** |
| webview `vite build` | 通过，产物已同步 `dist/webview/index.html` |

新增测试文件：

- `src/test/sessionSync.test.ts`
- `webview/src/hooks/windowCallbacks/__tests__/callbackArity.test.ts`
- `webview/src/hooks/windowCallbacks/__tests__/callbackRouting.test.ts`
- `webview/src/hooks/windowCallbacks/__tests__/onSessionHydrated.test.ts`

---

## 7. 遗留风险 / 后续

1. **`MessagesErrorBoundary` / `aborted` 中性提示 / `questionCard` / v2 `subagent` 工具名**（原 P5）
   本批未做，仍与 idea 有差距。
2. **代际校验**：`SingleWebviewChannel` 仍只靠 `disposed`，未引入 idea 的 `pageGeneration`。
   webview 重载但 panel 未销毁的窗口里，旧代际迟到消息仍可能落进来。
3. **panel 恢复的记录顺序**依赖 VS Code 归还顺序与持久化顺序一致；不一致时只影响标题/会话
   对应关系，不会丢消息（会话 id 绑错会表现为「打开的是另一段对话」，可手动切换）。
4. `load_session` 与 `switch_session` 都会触发一次 `listMessages`；同一会话连续切换存在冗余往返，
   后续可按 sessionId + 时间窗去抖。
