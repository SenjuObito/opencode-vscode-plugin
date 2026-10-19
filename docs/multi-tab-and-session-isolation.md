# 多会话与多视图架构（单实例 · 多视图）

本文档描述 `opencode-vscode-plugin`（OpenCode Buddy）当前的会话与视图模型：**一个扩展进程只有一个聊天实例，侧边栏与编辑器窗口都只是它的挂载点**。

> 历史背景：早期实现是「一个视图一个 `ChatInstance`」，用多个面板来充当多会话。标签栏支持多会话之后，这条路径被移除——面板不再是会话的载体，只是同一份状态的另一个展示窗口。

---

## 一、模型

```
        ┌──────────────────────── ChatInstance（全局唯一）────────────────────────┐
        │  HandlerContext · MessageDispatcher · SessionManager · OpenCodeSession  │
        │  SessionState（按 sessionId 分桶） · NotificationService                 │
        └───────────────────────────────┬────────────────────────────────────────┘
                                        │ ViewRegistry
        ┌───────────────────┬───────────┴───────────┬────────────────────┐
        │                   │                       │                    │
   view:left           view:right             panel:tab_1          panel:tab_2
  （侧边栏）           （侧边栏）             （编辑器窗口）        （编辑器窗口）
```

三条不变量：

1. **会话是全局的**：`SessionManager` 里每个 `sessionId` 只有一份状态，任何视图看到的都是同一份。
2. **标签是全局的**：标签列表 + 当前激活标签由宿主持有并持久化，所有视图投影同一个列表。
3. **视图是可丢弃的**：关闭视图只解绑通道，不销毁实例、不关闭会话。

---

## 二、出站通道：广播与定向

`ViewRegistry` 实现 `WebviewChannel`，因此可以原样塞进 `HandlerContext`：

| 方法 | 语义 | 典型用途 |
|---|---|---|
| `callJavaScript(fn, ...args)` | 广播给所有挂载视图 | 消息增量、流式块、状态变更、标签列表 |
| `callJavaScriptTo(viewId, fn, ...args)` | 只发一个视图 | 新建标签、视图专属推送 |
| `HandlerContext.callJavaScriptToOrigin` | 回给「发起本次消息的视图」 | `frontend_ready` 回放、编辑器上下文刷新 |

`HandlerContext.dispatchOrigin` 由 `ChatInstance.dispatchFrom(viewId, type, content)` 在分发期间设置，保证「谁问的答给谁」。

**为什么默认广播**：同一份会话状态在多个窗口同时可见时，只更新发起窗口会导致另一个窗口停在旧内容。广播是默认安全选项；只有「动作必须只发生一次」的场景才定向投递（如 `createSessionTab`，广播会让每个窗口各建一个空标签）。

---

## 三、标签栏：全局状态

### 3.1 归属

| 数据 | 归属 | 落点 |
|---|---|---|
| 标签 id / sessionId / 标题 / 共享标记 / 文件上下文开关 | 宿主 | `ChatTabStore` → `context.workspaceState`（`opencode.chatTabs`） |
| 当前激活标签 | 宿主（随快照广播） | 同上 |
| 消息数组、流式运行时、输入草稿、弹窗队列 | 各视图 | 前端 React state + `runtimeSnapshotsRef` |

只同步**结构字段**，不同步整包消息：N 个视图各持一份完整数组已经是 N 份快照，再反复整包广播会放大成 N 倍传输与渲染。消息靠会话广播自然收敛。

### 3.2 协议

| 方向 | 类型 | 语义 |
|---|---|---|
| 视图 → 宿主 | `get_tabs` | 视图挂载时索取权威快照（只回给发起者） |
| 视图 → 宿主 | `sync_tabs` | 结构变化上行（新建 / 关闭 / 切换 / 改名） |
| 宿主 → 视图 | `apply_tabs` | 广播权威快照 `{ tabs, activeTabId, restored }` |
| 视图 → 宿主 | `request_session_snapshot` | 远端切换到一个本视图没有内容的标签时，补一次水化 |

### 3.3 收敛规则

- **首视图播种**：宿主没有存档（`restored: false`）时，视图保留自己的本地标签并把它上行，而不是被空列表清空。
- **远端应用**：`apply_tabs` 只覆盖结构字段，保留本地运行时（消息、草稿、弹窗）。若激活标签变了，走 `selectTab(id, { remote: true })`——本地换页，但**不重复下发** `switch_session` / `set_mode` / `set_model`，因为宿主就是发起方。
- **签名去抖**：远端应用后立即把 `lastSentSignature` 对齐到应用后的值，回声不会再触发一轮上行。
- **绑定跟随**：同一标签的 `sessionId` 被别的窗口绑定（对方发出了第一条消息）时，本视图同步 `currentSessionId`，否则它会以为自己是「未绑定」，下一条消息另起会话。

### 3.4 「至多一个未绑定标签」

`createTab()` 的守卫：

```ts
const existingUnbound = tabsRef.current.find((t) => !t.sessionId);
if (existingUnbound) { selectTab(existingUnbound.id); return; }
```

因为标签列表是全局的，这一处守卫就覆盖了所有视图——不再需要跨视图的草稿仲裁器，也不需要「panel 优先于侧边栏」这类规则。

---

## 四、视图生命周期

### 4.1 挂载

| 时机 | 行为 |
|---|---|
| 侧边栏 `resolveWebviewView` | `attachView(view:<host>)`；重复 resolve 先解绑旧的 |
| 新建编辑器窗口 | `TabManager.openNewTab()` → `attachView(panel:<tabId>)` |
| 窗口重载 | `WebviewPanelSerializer` → `adoptRestoredPanel()` → 挂载为又一个视图 |

`frontend_ready` 到达时：

1. `context.markViewReady(origin)`（供「新建对话」挑一个已就绪视图）；
2. 定向回放 `applyBackendTabState` / `onModeReceived` / `setSessionId`；
3. 若会话已绑定 → `hydrateSessionToWebview({ origin: true })` 补整包快照；
4. 宿主内存为空且服务端有内容 → `resyncSessionFromServerIfNeeded`。

**不再重置共享会话。** 视图就绪只意味着「多了一个挂载点」，宿主的会话不能因此被清空——这是旧 `reconcileWithFreshView` 被删除的原因。

### 4.2 卸载

- 关闭编辑器窗口：`detachView` → 从 `ViewRegistry` 摘除；会话与标签都保留。
- 关闭侧边栏视图：同上（`onDidDispose` 里解绑）。
- 最后一个视图关闭：`callJavaScript` 变成空操作，后台流式继续跑；下次挂载时靠水化补齐。

### 4.3 视图就绪缓冲

`frontend_ready` 在 `main.tsx` 里随 bridge 就绪发出，可能早于 React 回调注册。因此 `onSessionHydrated` 与 `apply_tabs` 各有一个占位缓冲（`window.__pendingSessionHydrated` / `window.__pendingTabs`），真实回调注册时补放最后一包。两者都是整包覆盖语义，丢中间包无副作用。

---

## 五、会话级路由（仍然隔离）

单实例不意味着会话之间共享状态。所有会话级请求都带会话标识：

| 请求 | 键 | 处理 |
|---|---|---|
| `send_message` | `sessionId` / `tabId` / 当前会话 | `SessionHandler` 依次解析，`tabId` 会补建会话 |
| `revert_session` / `unrevert_session` / `fork_session` / `compact_session` | `{ sessionId, messageId }` envelope | 未知 id 直接报错（改的是服务端真实数据，不能猜） |
| `set_model` | `{ sessionId, silent }` | `silent` 表示仅回显（切标签），不重推用量环 |
| `set_mode` / `set_reasoning_effort` | `{ sessionId }` | 未知 id 补建会话（新标签的默认值不能写进旧标签） |
| `refresh_editor_context` | `{ tabId, enabled }` | 只回给发起视图 |

后台会话的流式增量按 `sessionId` 路由到对应标签的快照，不会写进前台标签（`updateBackgroundTab` 的谓词匹配）。

---

## 六、通知与声音

- **系统通知**：标题 `【会话名】任务已完成`，正文取最后一条 assistant 的最后一个 text block（220 字符）。
- **点击「查看」**：`NotificationService` → `context.focusSession(sessionId)` → `TabManager.revealSession` → 有窗口就 reveal 一个 + 广播 `focus_session`，视图内切到持有该会话的标签。
- **声音**：与 idea 对齐，按「任务完成 / 提问 / 出错」三类播放；单实例下天然只播一次，不需要跨实例去重。
- **焦点门控**：`systemNotificationOnlyWhenUnfocused` 仍以 `vscode.window.state.focused` 判定（窗口级，不是视图级）。

---

## 七、已知边界

1. **N 份消息副本**：每个视图都持有完整消息数组。视图数量通常 ≤ 3；若要继续扩张，需要改成「宿主持有 + 视图按需取页」。
2. **流式中远端切换不水化**：实时文本由各视图的 accumulator 持有，整份替换会吞掉半截输出。切标签只在空闲时补水化（`request_session_snapshot` 也带同样条件）。
3. **`load_session` 与 `switch_session` 各打一次 `listMessages`**：可按时间窗去抖，尚未做。
4. **`pageGeneration` 代际校验缺失**：极快来回切换时，理论上有旧响应覆盖新视图的窗口。

---

## 八、关键文件

| 文件 | 职责 |
|---|---|
| `src/host/router/ViewRegistry.ts` | 视图挂载表 + 广播/定向投递 + 就绪订阅 |
| `src/host/router/HandlerContext.ts` | 分发来源、`callJavaScriptToOrigin`、会话注册表 |
| `src/host/session/ChatInstance.ts` | 单实例装配；`attachView` / `dispatchFrom` |
| `src/host/tabs/TabManager.ts` | 编辑器窗口管理；`openChat` / `revealSession` / 序列化恢复 |
| `src/host/tabs/ChatTabStore.ts` | 标签列表持久化（`workspaceState`） |
| `src/host/handlers/ChatTabHandler.ts` | `get_tabs` / `sync_tabs` / `request_session_snapshot` |
| `src/host/handlers/WindowEventHandler.ts` | `frontend_ready` 回放与定向水化 |
| `webview/src/hooks/useSessionTabs.ts` | 标签投影与上行；`apply_tabs` 合并 |
