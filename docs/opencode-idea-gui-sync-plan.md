# opencode-idea-gui → opencode-vscode-plugin 架构同步技术方案

> 版本：2.1（修订版）
> 日期：2026-10-28
> 状态：实施蓝本
> 源仓库：`opencode-idea-gui`（HEAD `4a5b42a`，release 0.3.0）
> 共享核心：`opencode-buddy-core`（tag `v1.0.0`）
> 目标仓库：`opencode-vscode-plugin`（分支 `feature/opencode-v2`）
>
> 本文取代并合并以下已删除文档：
> `multi-tab-and-opencode-v2-sync-plan.md`、`multi-tab-and-session-isolation.md`、
> `opencode-v2-adaptation-guide.md`、`opencode-v2-compatibility-analysis.md`。

---

## 0. 本版修订要点（相对草案）

| # | 草案写法 | 实际代码 | 影响 |
|---|---|---|---|
| 1 | 把"分享会话"列入 tab 右键菜单与 i18n 交付项 | opencode 服务端 v2.1.4 已移除 share 端点；idea 用 `SHARE_MENU_ENABLED = false` 隐藏入口，宿主 handler 保留但不暴露 | 本仓库必须同样隐藏（头部 share 按钮也要去掉），不能当新功能搬 |
| 2 | "以 idea webview 整树覆盖" | 两仓 webview 共 **658 个文件**：**354 个完全一致**（源码 276 / 测试 78）、**225 个同名分叉**（源码 159 / 测试 66）、**73 个 idea 独有**（源码 36 / 测试 37）、**6 个 vscode 独有**；idea 独有的 36 个源码文件中 6 个是 VS Code 没有的功能（命令管理、模式配色、错误边界、Aero 图标等） | 整树覆盖会把 IDEA-only 功能与死 UI 一起带进来；改为"架构文件照搬 + 25 个重分叉文件逐个人工合并" |
| 3 | 协议写成 `{v, type, tabId, sessionId, turnId, seq, payload:{delta}}` | 真实信封是 `{v:2, type, fn, tabId, epoch, sessionId?, turnId?, seq?, payload:{args:[...]}}`（位置参数事件）或命名 payload（`TabEvent`）；批次上限 64 条 / 32k 字符，active:background = 3:1 | 协议实现必须按真实结构，否则事件全部落空 |
| 4 | 事件名自行发明（`prompt.rejected`、`tab.reordered`、`tab.created` …） | 权威目录是 `EventCatalog`（**148** 个语义键，每个带 legacy `fn`；与 webview `SEMANTIC_HANDLERS` 双向 parity），例如 `session.cleared`、`message.prepended`、`turn.settled`、`prompt.question.closed`、`tab.state` | 少一个键就是一条静默丢失的事件 |
| 5 | 命令清单含 `session.hydrate`、`tab.reorder`、`permission.reply` | 实际无 `session.hydrate`（后台 tab 走 `session.load`）、无 `tab.reorder`（排序仅前端本地）、权限回复是 `permission_decision` / `ask_user_question_response` / `ask_user_question_reject` / `plan_approval_response` | 命令发出去没人接 |
| 6 | "contexts 降为纯 UI"、"运行态全 per-tab store"、"不做快照交换" | 现状：`MessagesContext` 已是 `TabStore` 的投影；流式运行态是 `useStreamingMessages` 里的 per-tab map；**状态标量（loading/streaming/usage/revert…）仍是 React state + 切 tab 时 `TabStatusStore` 快照交换** | 多视图下快照交换会分叉，必须改成 TabStore 权威（本仓库必要偏离，见 §5.4） |
| 7 | "删除 `applyBackendTabState`" | `tab.state → applyBackendTabState` 仍在目录中，用于恢复该 tab 的 model/mode/reasoning | 删了会导致刷新后模型/模式丢 |
| 8 | `revision` 快照版本 | 实际是 `sequence`（coalescer 单调号）+ `baseIndex`（窗口起点）+ `epoch`（tab 绑定代际）+ per-session barrier | 幂等/乱序判定实现错误 |
| 9 | 只覆盖架构与部分功能 | 用户可见功能仍需逐项迁移：启动页、图标、空态背景、模式/模型/推理、权限/问题弹窗、状态面板、附件、`@`、文件上下文、bash、opencode 命令 | 已补 §10（14 项），P8 按该章验收 |

---

## 1. 审计结论

### 1.1 三层现状

| 层 | 结论 |
|---|---|
| core | **已完成**：NDJSON 信封 `{id, session, turn, seq, line}`、`[TURN_END]`、引擎三态注册表、共享查询身份规则（`utils/request-identity.js`）。本仓库 pin 在 `v0.1.0`，必须升到 `v1.0.0` |
| 宿主 | **仍是单会话**：`HandlerContext.getSession()` 单槽（30 处调用）、`SessionManager` 切会话即 `interrupt+dispose`、权限借会话、`SessionCallbackAdapter` 全单参、daemon 只读 `{id,line}`、无 `engine_status` |
| webview | **继承 VS Code 版单会话结构**：无 `store/`、无 `hostDispatcher`/`hostEventRegistry`、无 `sessionIdentity`/`sequenceBarrier`、无 tab 栏；但公共代码与 idea 同源 |

### 1.2 webview 文件分叉统计（不含 tokentracker）

| 分类 | 数量（源码 / 测试） | 处置 |
|---|---|---|
| 两仓内容完全一致 | 354（276 / 78） | 不动 |
| 同名但已分叉 | 225（159 / 66） | 仅 25 个重分叉文件需三方合并，其余按原样保留（§11） |
| idea 独有 | 73（36 / 37） | 30 个架构文件照搬；6 个 IDEA-only 不搬 |
| vscode 独有 | 6（5 / 1） | 保留 3（`wxq.png`、`useHistoryLoader.test.ts`、`types/protocol.ts`）、删除 3（`.DS_Store`、`sessionTransition.ts`、`skipNewSessionConfirm.ts`） |

**159 个分叉文件里，真正承载本次重构的约 25 个**（`messageCallbacks` 910 行、`App.tsx` 846、`header.less` 589、`streamingCallbacks` 534、`registerCallbacks` 324、`global.d.ts` 307、`ChatHeader` 304、`main.tsx` 288、`useSessionManagement` 288、`sessionCallbacks` 227、`useDialogManagement` 224、`MessagesContext` 212、`permissionCallbacks` 205、`useStreamingMessages` 181、`utils/bridge.ts` 180 …），其余是样式、i18n、版本文件与少量功能修补。

### 1.3 两仓功能面对齐（必须先确认，再动手）

| 能力 | idea | vscode | 处置 |
|---|---|---|---|
| 多会话 tab | ✅ webview 内 tab | ❌ 原生编辑器 tab = 会话 | **移植** |
| 分享会话 | 入口已隐藏（服务端 v2.1.4 移除端点），宿主 handler 保留 | 头部 share 按钮可用 | **隐藏入口**（头部按钮移除，宿主 handler 休眠） |
| Node 路径检测 | ✅ `NodeDetector` + 设置项 + 进程管理 | ❌ 用 VS Code 自带 node | **不搬** |
| 字体系统（IDE/UI/Code 三套 + 系统字体列表） | ✅ | 仅有编辑器字体同步 | **不搬**，保留现有 |
| opencode 命令管理（PromptSection） | ✅ 新增设置页 | ❌ | **不搬**（除非单独立项） |
| 状态栏 widget / 提交信息生成 / 提示词增强 | ✅ 有对应设置与事件 | 有 `CommitSection` 等设置，但语义事件不同 | **按 VS Code 现状保留**，不按 idea 重写 |
| 会话转 CLI（`convert_to_cli_session`） | 已移除 | 仍在历史列表 | **删除**（宿主无实现） |
| 新建会话二次确认 | 已移除 | 仍在（`skipNewSessionConfirm` / `newSessionConfirm`） | **删除**（tab 即新会话） |
| `DaemonStatus` 失败分类（phase/code/installCmd） | ❌ 只有 alive/serveReady + engine | ✅ | **保留 VS Code 版**，只补 `engine` |
| 附件上传 | 分块 `attachment.prepare/chunk/complete/abort`，按 tab 落盘 | 单帧 base64 随 `send_message_with_attachments` | **移植分块模型**（保留 tab 归属） |
| 权限/提问/计划 | `PromptBroker` + 三类 future + tab/session 归属 | 单 handler 内 Map，借当前会话 | **移植** |

> **判断规则**：只搬"多会话身份 + 语义事件 + per-tab 状态 + v1/v2 引擎链路"。凡属于 IntelliJ 平台能力或 idea 独有产品功能，一律不搬；凡 VS Code 已有更完整实现的（daemon 失败分类），以本仓库为准。
>
> 每个功能域的具体落点、验收与陷阱见 **§10**；实施状态见 `docs/migration-progress.md`。

---

## 2. 决策基线

| ID | 决策 |
|---|---|
| **D1** | **单实例多视图**：扩展宿主只创建一个 `ChatWindow`（一个 `TabRegistry`）。左侧栏、右侧栏、每个 `WebviewPanel` 都是它的视图，显示同一批 tab 与同一个 activeTab。 |
| **D2** | 视图可随时销毁重建；窗口（注册表）在扩展宿主生命周期内常驻。视图关闭不关会话。 |
| **D3** | 多会话 = webview 内 tab；原生编辑器 tab 只代表"视图"。`openChat` 打开新面板 = 再开一个视图。 |
| **D4** | 扩展重启不恢复 tab（只开一个新会话）；设置仍通过 Memento 持久化。 |
| **D5** | 缺失身份 = 丢弃 + 计数，禁止回落"当前会话/活动 tab"。 |
| **D6** | 引擎判定只在 core；宿主只注入设置、缓存状态、展示。 |
| **D7** | Node 使用 VS Code 自带：`OPENCODEBUDDY_NODE_BIN = process.execPath`；不移植 `NodeDetector`，设置中不保存 node 路径。 |
| **D8** | 分享会话入口隐藏（`SHARE_MENU_ENABLED = false` 同款），宿主代码保留休眠。 |

---

## 3. 目标架构

### 3.1 单实例多视图

```
VS Code 窗口（Extension Host）
┌───────────────────────────────────────────────────────────────┐
│ ChatWindow（唯一，activate 时创建）                            │
│   TabRegistry  ── TabRecord(tabId, sessionId?, router, actor)  │
│   activeTabId（宿主权威）                                      │
│   ViewRegistry ── Set<viewId → WebviewChannel>                 │
│   PromptRegistry / TabCommandRouter / TabEventRouter           │
└──────┬──────────────────┬──────────────────┬──────────────────┘
       │ view:left        │ view:right       │ view:panel#1
       └──── 同一批 tab / 同一个 activeTab / 同一份消息 ─────────┘
```

**与 idea 的关键差异**：idea 的 `activeTabId` 与 tab 列表由 **webview** 拥有，宿主只镜像（用于窗口标题/通知）。本仓库多视图共享，必须**上移到宿主**：

| 状态 | idea | 本仓库 | 原因 |
|---|---|---|---|
| tab 列表 | webview `TabStore` | 宿主 `TabRegistry`，webview 镜像 | 多视图必须单一真源 |
| activeTabId | webview | 宿主 | 任一视图切换需广播全视图 |
| 排序 | webview 本地 | 宿主（多视图一致） | 否则两视图顺序不同 |
| tab 标题 | 宿主 `TabRecord` + webview 镜像 | 同（不变） | 已是宿主权威 |

由此新增四条规则：

1. `tab.activate` 由任一视图发起 → 宿主 `TabRegistry.activate` → 广播 `tab.activated {tabId}` → **所有视图**执行切换（发起视图需按 requestId 去重，避免自回声）。
2. `tab.create` / `tab.close` 由任一视图发起 → 宿主建/删记录 → 广播 `tab.created {tabId}` / `tab.closed {tabId}` → 各视图同步本地列表。
3. `tab.reorder` 新增为宿主命令（idea 没有），宿主保存顺序并广播 `tab.reordered {tabIds[]}`。
4. 视图挂载/重建 → `view.ready` → 宿主回 `tab.resync`（含完整顺序与 activeTabId）。

### 3.2 分层职责

| 层 | 职责 | 禁止 |
|---|---|---|
| core | SSE → 带身份 marker | "当前会话"概念 |
| daemon 传输 | 每行 `{id, session, turn, seq, line}` | 借用别的请求的 session |
| `TabRegistry` | tab ↔ session 绑定、顺序、活动项 | 用 active 决定归属 |
| `TabSessionActor` | 单 tab 串行状态变更 | 跨 tab 共享可变状态 |
| `TabStreamRouter` | 每会话一个 parser/handler | 用请求 id 决定数据归属 |
| `TabEventRouter` | 按 tab 分 lane、合并、广播 | 判断"该给谁" |
| `PromptRegistry` | 每个 prompt 的 tab/session/future | 整表 `clear()` |
| webview `TabStore` | 按 tabId 存 UI 状态 | 全局单槽、空身份回落 |
| 视图 | 渲染 activeTab | 写归属 |

### 3.3 四种 ID

| ID | 产生者 | 生命周期 | 用途 |
|---|---|---|---|
| `tabId` | webview（`crypto.randomUUID`，`tab-` 前缀） | tab 存在期间 | 跨层路由主键 |
| `sessionId` | opencode server（`ses_*`） | 会话期间 | tab 的可空绑定 |
| `turnId` | core（服务端 `durable.seq`） | 一个回合 | 终态幂等 |
| `requestId` | 发起方 | 一次请求/命令 | 幂等键，不表达归属 |

### 3.4 不变式

| ID | 内容 | 验证 |
|---|---|---|
| INV-1 | 会话级事件必带 `tabId`；已绑定时同时带 `sessionId` | 协议单测 |
| INV-2 | `sessionId` 只能是 `ses_*` 或 null | 断言 |
| INV-3 | 一 tab ≤ 1 session；一 session ≤ 1 tab | `TabRegistry.bind` 原子检查 |
| INV-4 | `activeTabId` 不参与消息/权限/命令路由 | grep 护栏 + 并发测试 |
| INV-5 | 终态按 `(tabId, turnId)` 幂等 | 单测 |
| INV-6 | 关闭 tab 释放 session/sink/actor/coalescer/prompts/attachments | 泄漏测试 |
| INV-7 | 缺失身份丢弃 + `unattributed` 计数 | 单测 + 指标 |
| INV-8 | 视图重建后 `tabId` 不变；旧 `epoch` 丢弃 | reload 测试 |
| INV-9 | 同一 tab 的状态只由**一个 store 写入**（不得 React state 与 store 双写） | code review + 双视图一致性测试 |

---

## 4. 宿主设计

### 4.1 模块（新增）

```
src/host/tab/                    ← 对应 idea com.opencodebuddy.tab
  TabId.ts SessionId.ts TurnId.ts
  TabState.ts                    NEW | CREATING | BOUND | LOADING_HISTORY | STREAMING | CLOSED
  TabSettings.ts                 provider/model/permissionMode/reasoningEffort/contextEnabled/title/titleSource
  TabRecord.ts                   tabId, sessionId?, session, router, actor, settings, attachments, epoch
  TabRegistry.ts                 Map<TabId,TabRecord> + Map<SessionId,TabId> + activeTabId + order
  TabSessionActor.ts             per-tab Promise 串行队列
  TabSessionFactory.ts           prepare / attach（历史）/ attachSession（fork）
  TabCommand.ts TabCommandRouter.ts
  PendingSend.ts                 bootstrap 缓冲 + 30s 超时
  TabStreamRouter.ts             每会话一个 parser + handler（数据面）
  TabSnapshot.ts                 resync 快照
src/host/window/
  ChatWindow.ts                  ← 取代 ChatInstance；持有 registry/views/prompts/commands/events/dispatcher
  ViewRegistry.ts                ← 本仓库新增：viewId、可见性、焦点、代际
  TabEventRouter.ts              ← 本仓库新增：按 tab lane 批量广播（idea 是 BridgeScheduler）
  TabSessionCommandHandler.ts    fork/revert/unrevert/compact（share 保留休眠）
src/host/prompt/
  PromptRegistry.ts PendingPrompt.ts
src/host/router/
  HostCommand.ts                 出站信封解析与校验
```

**对应关系**

| idea | VS Code | 说明 |
|---|---|---|
| `TabRegistry` / `TabRecord` / `TabSessionActor` / `TabSessionFactory` | 同名 TS | 语义照搬；actor 用 Promise 链替代线程池 |
| `TabStreamRouter` | 同名 TS | 照搬 |
| `TabCommandRouter` | 同名 TS | 照搬（LRU 2048 去重，`tab.create` 内联） |
| `BridgeScheduler`（JCEF 分 lane + `executeJavaScript`） | `TabEventRouter` | 保留 lane/权重/合并/预算；传输换 `postMessage` |
| `PromptBroker` | `PromptRegistry` | 照搬三张表 + `pendingForTab` / `rejectForTab` |
| `MessageDispatchGate`（EDT/CEF 生命周期） | `ViewRegistry` 视图代际 | 只保留"旧视图事件丢弃"语义 |
| `WebviewEventQueue` / `SurfaceFrameFence` / watchdog | 无 | 不搬 |

### 4.2 `TabRecord` / `TabRegistry`

- `TabRecord` 无 active 字段；`activeTabId`、`order` 在 registry。
- `bind(tabId, sessionId, session, adapter, coalescer)`：校验双向唯一 → 写索引 → `epoch++` → 触发 `session.bound`；失败回滚。
- `close(tabId)`：置 CLOSED → 流式中先 abort → 拒绝该 tab 的 prompts → 注销 sink → `actor.close()` → 释放 attachments → 移除索引（**幂等**）。
- `snapshots()`：`{tabId, sessionId?, title, active, streaming, loading, epoch}`（与 `TabSnapshot.toJson` 一致）。

### 4.3 `TabSessionActor`

```ts
class TabSessionActor {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  submit(task: () => void | Promise<void>): boolean {
    if (this.closed) { this.rejected++; return false; }
    this.tail = this.tail.then(async () => {
      if (this.closed) return;
      try { await task(); } catch (e) { logWarn('[actor] task failed', e); }
    });
    return true;
  }
  close(): void { this.closed = true; }
}
```

顺序保证：命令 → daemon 行 → 终态 → 关闭，全部进同一队列；不同 tab 并行。

### 4.4 `TabCommandRouter`

- 所有出站命令先经 `HostCommand` 校验：`v==2`、`type`、`requestId`、`tabId`（窗口级可为 null）、`sessionId` 与绑定一致。
- `tab.create` 内联执行（无既有记录可竞争）；其余投递到目标 tab 的 actor。
- `requestId` LRU 2048 去重（reload 重放只执行一次）。
- 找不到 tab → `command.rejected{TAB_NOT_FOUND}`，**不回落到活动 tab**。

### 4.5 `TabStreamRouter`（数据面）

- 每会话一个 `MarkerParser` + `MessageHandler` 常驻实例 → out-of-turn 事件（标题、todo、`message.removed`、服务端 prompt close、迟到 error）有归属。
- `adapter` 与 `coalescer` 成对持有（避免跨会话混搭）。
- `OpenCodeDaemonBridge` 数据行分流：

```
session 有 sink            → sink.onLine(line)
session 为空 + id 有请求    → 该请求的 PendingSend（仅新会话 bootstrap）
其他                        → orphan 缓冲 + unattributed 计数
done                        → 按 id 结算请求（不参与数据归属）
```

- 遵守 core 的共享查询规则：**响应按 `id`、事件按 `session`**；`listMessages` 做"播报条数 vs 实收条数"对账，不符即报错。

### 4.6 会话生命周期

| 流程 | 关键点 |
|---|---|
| 首次发送 | `session.send{tabId, sessionId:null, payload}` → 无 session 则 `prepare`（CREATING + PendingSend）→ `[SESSION_ID]` → `bind` → 注册 sink → `session.bound` → 回放缓冲 |
| 历史加载 | `session.load{tabId, sessionId, title}` → 校验未被占用 → 空 tab 复用否则新 tab → `attach` → `preconnect` → `message.snapshot` → `session.loaded` |
| 后台 tab 激活 | 已绑定则 `session.load` 软刷新（同会话不重复 hydrate）；未加载过则首次拉取 |
| 中断 | `session.interrupt{tabId, sessionId}` → 仅 aborts 该 session；查不到目标时先发 `turn.ended{reason:'aborted'}` 释放前端再返回 |
| 关闭 tab | 见 §4.2；最后一个 tab 由 UI 立即新建空 tab |
| 关闭视图 | 仅 `ViewRegistry.detach`，不动会话 |
| daemon 重启 | 所有 STREAMING tab 收 `turn.ended{reason:'daemon_restart'}`，保留历史 |
| 视图重建 | `view.ready` → `tab.resync`（全量 tab 快照 + activeTabId）→ active tab 重放消息与状态 |

### 4.7 `ChatWindow` / `ViewRegistry`

- `ChatWindow` 取代 `ChatInstance`；`extension.ts` 只创建一次，注入左右 provider 与所有面板。
- 窗口内只注册**一套** `MessageDispatcher` + handlers（现在每个 `ChatInstance` 一套）；`HandlerContext` 改为窗口级，不再绑定单个 webview channel。
- `ViewRegistry`：`viewId`（注入 HTML 的 `window.__VIEW_ID__`）、`visible`、`focused`、`generation`；焦点变化用于弹窗选举。
- 广播：全局设置/主题走既有 `WebviewBroadcaster`；会话事件走 `TabEventRouter`（内部复用同一 channel 集合）。
- 面板标题：订阅 activeTab 变化 → `panel.title = activeTab.title`；`WebviewView` 标题保持 `OpenCode Buddy`（VS Code 限制）。

### 4.8 `PromptRegistry`

- 三类表：`requestId → {kind, tabId, sessionId, future, directory, deadline}`。
- 回复三重校验（tab 属于该请求 / session 匹配 / requestId 存在），失败回 `command.rejected`。
- 溢出：淘汰最旧（禁止整表清空）；`clearTab(tabId)` 在关闭 tab 时调用；超时只拒绝当前请求。

### 4.9 回复定向（多视图必须明确）

| 消息 | 目标 |
|---|---|
| 状态/数据类（`cli.status`、`settings.*`、`history.data`、`agents.updated`、`daemon.status`…） | **广播所有视图**（各视图都要显示同一份设置/列表） |
| 命令失败（`command.rejected`） | **只回发起命令的视图**（`HostCommand.viewId`） |
| 会话事件（`content.delta`、`message.*`、`turn.*`、`prompt.*`） | 广播所有视图，信封带 `tabId`/`sessionId`，由各视图写入自己的 `TabStore` |
| 弹窗请求（`permission.requested` 等） | 广播，但仅 `promptHostId` 渲染模态 |

实现约定：`BaseMessageHandler.callJavaScript(fn, ...args)` 保留原签名，内部转成 `TabEventRouter.broadcast`（沿用 `EventCatalog.semanticType(fn)`）；需要定向回复时显式调用 `replyToView(viewId, event)`。`HandlerContext` 不再提供 `getChannel()` 给业务 handler 直接使用。

---

## 5. Webview 设计（按真实职责）

### 5.1 store 的实际角色（勿照抄描述）

| 文件 | 实际职责 | 备注 |
|---|---|---|
| `store/tabStore.ts` | tab 列表 + active + `SessionTabData`（含 messages、标题、选择项、pending 等字段）；`updateTab`/`updateActiveTab`/`updateBackgroundTab`；模块级单例 | **本仓库将升级为唯一写入方**（§5.4） |
| `store/tabMessageStore.ts` | 每 tab 一个，按消息 id 对账（`messageKey`），拒绝 shrink、保留 streaming assistant | tab 对象按引用持有 |
| `store/tabDraftStore.ts` | 每 tab 草稿（text/attachments/fileTags/quotes） | 切 tab 时读写 |
| `store/tabStatusStore.ts` | **切 tab 边界的快照**（loading/streaming/thinking/status/revert/compact/usage/todo/subagent/fileChanges），供恢复 | 本仓库改为不再依赖（§5.4） |
| `store/tabPromptStore.ts` | 每 tab 待决 permission/question/plan 快照 | 同上 |
| `store/tabTransitionStore.ts` | 每 tab 切换令牌（token 防迟到释放） | 照搬 |
| `store/tabRuntime.ts` | **仅** `isTabTurnActive(tab)` 判定函数 | 不是 store，勿误建 |
| `store/agentStore.ts` | 宿主推送的 agent 目录快照（`agents.updated`），`useSyncExternalStore` | 照搬 |
| `store/questionAnswerStore.ts` | 问答卡片答案（按 callId 索引） | 照搬 |
| `hooks/useStreamingMessages.ts` | **流式运行态的真正 owner**：per-tab `StreamingRuntime` map（content/thinking/streaming/messageIndex/turnId/autoExpanded…），refs 只是活动 tab 的投影 | 照搬 |

### 5.2 事件分发

- 唯一入口：`window.__opencodeDispatch(type, args)` / `window.__opencodeDispatchBatch(batch)`；`hostEventRegistry` 是唯一路由表，**没有 `window.<fn>` 回退**（未注册事件进队列，TTL 30s / 上限 2000，React 挂载后 flush）。
- VS Code 传输：宿主 `postMessage({ type: 'host.events', batch })`；`vscodeBridge.ts` 增加该分支调用 `__opencodeDispatchBatch`。
- 入站信封兼容三种 payload：`payload.args`（位置参数事件）、命名 payload（`TabEvent`）、单字段 `{data}` 包装。
- **现状偏离**：宿主仍会对部分事件额外调用一次 `callJavaScript(fn, json)`，webview 也仍保留 `window[fn]` 分发（`vscodeBridge.dispatchHostMessage`）。这是 tab 化之前的旧通道，退场计划见 §5.6。

### 5.3 消息与运行态

- delta 只写该 tab 的 `StreamingRuntime`，活动 tab 才调度 rAF（33ms 与后端节流对齐）。
- 快照负责结构：`message.snapshot`（`sequence` + `baseIndex`）、`message.tail`、`message.prepended`、`message.removed`、`message.uuid.patched`。
- 乱序拒绝：`sequenceBarrier` 的 per-session 基线 + `epoch`。

### 5.4 多视图适配（本仓库必要偏离）

| 问题 | idea 现状（单视图可行） | 本仓库做法 |
|---|---|---|
| 状态标量（loading/streaming/thinking/usage/revert/todos/subagent/fileChanges） | React state 是活动视图，切 tab 时 `TabStatusStore` 保存/恢复 | **改成 `TabStore[tabId]` 为唯一写入方**，事件直接写目标 tab；React context 用 `useSyncExternalStore` 订阅活动 tab（`MessagesContext` 已有此模式，扩大范围即可） |
| 切 tab | 每个视图各自执行 `selectTab`（保存/恢复快照） | 宿主广播 `tab.activated` → 各视图只切换 `activeTabId` 与派生视图，不搬运状态 |
| 草稿 | 仅本地 | 输入 300ms 去抖 → `tab.draft.changed{tabId, draft}` → 宿主镜像 → 转发其他视图；聚焦视图优先，非聚焦只更新 store |
| 滚动位置 | 每 tab 保存 | 每**视图**本地保存（`Map<tabId, scroll>` 每视图一份），不广播 |
| 弹窗 | 单视图，自然唯一 | `PromptRegistry` + `promptHostId` 选举（聚焦视图 > 最近可见 > 主侧栏）；`prompt.host.changed` 通知切换 |
| 页面切换（chat/history/settings） | 单视图 | `view.navigate` 广播，保持全视图一致 |
| 标题编辑 | 头部内联编辑 | 移入 tab（双击/F2 + 右键菜单） |

> INV-9：以上状态禁止"React state 与 store 双写"。`TabStatusStore` 在本仓库可删除；若保留，只作为迁移期兼容层，不得参与运行时。

### 5.5 删除清单（已核实）

| 删除项 | 原因 |
|---|---|
| `utils/skipNewSessionConfirm.ts` + `skipNewSessionConfirm` 偏好 + `newSessionConfirm` 文案 | idea 已移除；tab 即新会话 |
| `hooks/windowCallbacks/sessionTransition.ts` + `__sessionTransitioning` | 被 `tabTransitionStore`（per tab）取代 |
| `useSessionManagement.convertToCliSession` + 历史列表按钮 + i18n | idea 已移除，宿主无实现 |
| `create_new_session` / `switch_session` / `interrupt_session` / `send_message` 等旧命令名 | 由 `tab.*` / `session.*` 取代 |
| `ChatHeader` 的 share 按钮与 `isShared` 展示 | 分享入口隐藏（D8） |
| 头部内联标题编辑 | 移入 tab |

**不要删**：`applyBackendTabState`（`tab.state`）、`tab.title.sync`（宿主已置空但保留兼容）。

**发送但无 handler 的遗留命令（实测 12 个；`cardDebug` 走旁路日志，不计入）**

| 命令 | 处置 |
|---|---|
| `convert_to_cli_session` | 删除（idea 已移除，宿主无实现） |
| `deep_search_history` | 删除（无实现） |
| `get_node_processes` / `kill_node_process` / `kill_all_orphans` / `restart_node_daemon` | 删除（Node 进程管理，D7 不搬） |
| `open_class` | 删除（IntelliJ 跳转类，VS Code 无对应） |
| `surface_damage_applied` | 删除（JCEF OSR） |
| `set_custom_model_pricing` / `set_thinking_enabled` | 删除（无实现） |
| `write_clipboard` | 删除（复制走宿主 `copy_to_clipboard` 通道） |
| `open_browser` | **先确认**：外链若依赖它，则补 handler；否则删除 |

---

### 5.6 旧窗口级回调总线（legacy）退场（待做）

**定义**：tab 化之前的投递通道 —— 宿主 `callJavaScript(fn, json)` → 通道 `postMessage({ type: fn, args })` → webview `vscodeBridge.dispatchHostMessage` 里的 `window[fn]`。tab 化后的数据面走 §5.2 的 `host.events` 批次；旧通道目前只剩两类用途：迁移期 fallback（`TabEvent.legacy`）与窗口级功能（设置 / 字体 / 文件 / agent / MCP / 通知音…）。

**判定标准**：某个 legacy 函数名还有没有人收 —— `grep -rE "window\.<fn>\s*=" webview/src`。没有 = 宿主发了没人接的死调用。

**现状实测（2026-10-30）**：

| 指标 | 数量 |
|---|---|
| `EventCatalog` 语义事件 | 148 |
| legacy 函数名在 webview 无消费方（死流量） | 43 |
| 仍有 `window.<fn>` 消费方 | 105（会话类多已由 `SessionCallbackAdapter.emit` 置 `legacy:false`；窗口级功能仍在用） |

43 条死调用（宿主对外投递、webview 无对应 `window.<fn>`）：

| 分组 | 事件 → 旧函数名 |
|---|---|
| tab 生命周期 | `tab.resync→onTabResync`、`tab.created→onTabCreated`、`tab.closed→onTabClosed`、`tab.activated→onTabActivated`、`tab.reordered→onTabReordered`、`tab.draft.changed→onTabDraftChanged`、`tab.create.requested→createSessionTab` |
| 视图 | `view.ready→onViewReady`、`view.focus→onViewFocus`、`view.navigate→onViewNavigate`、`prompt.host.changed→onPromptHostChanged` |
| 提示 / 弹窗 | `permission.requested→showPermissionDialog`、`question.requested→showAskUserQuestionDialog`、`question.answered→onQuestionAnswered`、`question.invalidated→invalidateQuestionCard`、`plan.requested→showPlanApprovalDialog`、`prompt.closed→forceClosePermissionDialog`、`prompt.question.closed→forceCloseAskUserQuestionDialog`、`prompt.plan.closed→forceClosePlanApprovalDialog`、`command.rejected→commandRejected`、`attachment.failed→onAttachmentFailed` |
| 回合 | `turn.settled→onTurnEnd`、`turn.error→onTerminalError` |
| 会话 | `session.fork.bound→onForkBound`、`session.hydrated→onSessionHydrated`、`session.unshare.failed→onUnshareError`、`session.unshare.done→onUnshareSuccess` |
| 命令 / MCP / 设置 | `commands.deleted/listed/detail/saved→onCommands*`、`mcp.toggled→mcpServerToggled`、`settings.streaming/commit.generation/ai.title.generation/statusbar.widget/commit.prompt/project.commit.prompt/prompt.enhancer/commit.ai→update*` |
| Node（D7 不搬） | `node.path→updateNodePath`、`node.processes→updateNodeProcesses`、`node.process.killed→nodeProcessKillResult` |

**步骤 A：删死流量（行为等价，0.5d，先做）**

1. `TabEvent` 的 `legacy` 默认值改为 `false`（`src/host/tab/TabEvent.ts`）。
2. 删除 `TabEventRouter.broadcastBatch` 里的 legacy 循环（`src/host/window/TabEventRouter.ts` 中按 `item.legacy !== false` 调用 `channel.callJavaScript` 的那段），连同 `TabEventEnvelope.legacy` 与 `TabEvent.legacy` 字段。
3. `ChatWindow.createLegacyTarget()` 收敛为“仅窗口级未迁移功能可用”，并在步骤 B 收尾时删除。
4. 护栏（`src/test/multiSessionGuardrails.test.ts`）新增断言：
   - `src/host` 内不得对 `EventCatalog` 里的事件再走 `callJavaScript`；
   - `webview/src` 不得新增 `window.<fn> =` 赋值；
   - `eventCatalogParity` / `semanticEvents.parity` 继续双向一致。
5. 执行前核对脚本：对 `src/host` 每个 `publishTabEvent('<type>')`，确认 webview 已 `registerHostEvents({ '<type>': ... })`；**只对已有 v2 handler 的事件**关闭 legacy 投递（没有 handler 的事件先把 handler 补上，否则功能会变哑）。
6. 验收：`pnpm run compile` 绿；宿主 + webview 全量单测绿；VS Code 通道不再出现 `{ type: 'onXxx' }` 报文（加日志断言或单测覆盖）。

**步骤 B：窗口级功能迁 v2（独立工程，1.5d）**

1. 逐个迁移仍走旧通道的窗口级功能（`EventCatalog` 增条目 + `publishTabEvent` / 全局 lane + webview `registerHostEvents`）：设置（commit / statusbar / streaming / prompt enhancer）、agents / skills、字体 / 主题 / 语言、文件（list / path / diff / undo）、MCP、通知音 / 剪贴板 / 导出。
2. 全部迁完后删除 webview 的 `window.<fn>` 赋值、`vscodeBridge.dispatchHostMessage` 的 `window[fn]` 分支、宿主 `callJavaScript` 与 `createLegacyTarget`。
3. 注意：部分 `window.<fn>` 目前被 v2 handler **内部复用**（如 `todos.updated` 的语义 handler 内部调用 `window.onTodoUpdated`）。删除时要先把实现提成普通函数再改调用点，不能只删赋值。

**边界**

- 不能只在 webview 删 `window.<fn>`：`opencode-idea-gui`（JCEF）与本仓库共享同一份 `EventCatalog` 映射，跨仓 parity 测试以 catalog 为准；步骤 A 只改 **VS Code 宿主的投递策略**，不动映射本身。
- 未迁移完成前不得关闭 legacy：43 条死调用可以安全删，105 条里有真实消费方（窗口级功能），必须随步骤 B 一起走。

---

## 6. 协议

### 6.1 出站：`host_command` v2

```json
{
  "v": 2,
  "type": "session.send",
  "requestId": "uuid",
  "tabId": "tab-…",
  "sessionId": "ses_…|null",
  "payload": { "text": "hi", "model": "…", "permissionMode": "default" }
}
```

宿主校验：`v==2` → `type` 已知 → `requestId` 未处理 → `tabId`（窗口级命令可空）→ `sessionId` 等于绑定 → payload。
失败回 `command.rejected {tabId, requestId, code, message}`，`code ∈ TAB_NOT_FOUND | SESSION_MISMATCH | UNSUPPORTED_VERSION | MISSING_TAB_ID | MISSING_REQUEST_ID | UNKNOWN_TYPE`。

**真实命令目录（按代码核实）**

| 作用域 | 命令 |
|---|---|
| tab（`TabCommandRouter`） | `tab.create` `tab.activate` `tab.close` `tab.title.set` `tab.title.sync`(no-op) `tab.reorder`(本仓库新增) |
| 会话 | `session.send` `session.interrupt` `session.restart` `session.load` `session.rename` `session.fork` `session.revert` `session.unrevert` `session.compact` `session.share` `session.unshare`（+ 旧别名 `share_session` / `unshare_session`，休眠） |
| 设置 | `settings.mode` `settings.model` `settings.reasoning` `settings.mode.get` `context.refresh` |
| 附件 | `attachment.prepare` `attachment.chunk` `attachment.complete` `attachment.abort` |
| 提示 | `permission_decision` `ask_user_question_response` `ask_user_question_reject` `plan_approval_response` |
| 窗口 | 沿用本仓库现有：`history.*` `models.list` `get_cli_status` `open_file` `resolve_file_path` `show_diff` `mcp.*` `skills.*` `agents.*` `tokenTracker.*` 等（**不按 idea 重写**，只把 handler 内的 `getSession()` 改为按 tab/session 解析） |

> 命令名不要自行发明。实施时以 `webview/src/utils/bridge.ts` 的发送点 + 宿主 handler 的 `SUPPORTED_TYPES` 双向对账，并加一条"发送了但无 handler"的测试。

### 6.2 入站：真实信封

```json
{
  "v": 2,
  "type": "content.delta",
  "fn": "onContentDelta",
  "tabId": "tab-…",
  "epoch": 7,
  "sessionId": "ses_…",
  "turnId": 1042,
  "seq": 1047,
  "payload": { "delta": "hello" }
}
```

- 命名事件（`TabEvent`）：`payload` 是命名字段对象（`{delta}`、`{messages, sequence, baseIndex}`），identity 在信封 —— **这是新代码唯一允许的形态**。
- 位置事件（遗留 `callJavaScript`）：`payload.args` 是原参数数组；`type` 由 `EventCatalog.semanticType(fn)` 得出。仅用于尚未迁移到 `TabEvent` 的窗口级回调。
- `sessionId`：命名事件取自身字段；位置事件取"首参以 `ses_` 开头"（过渡规则，新代码禁止依赖）。
- VS Code 传原生 JSON（无需 `escapeJs`/二次转义），但**保留** payload 形状以便复用 webview 代码。

**批量与调度**（照搬 BridgeScheduler 语义）

| 参数 | 值 |
|---|---|
| lane | 每 tab 一条，另有 `__global` |
| 每批上限 | 64 条 或 32k 字符（单条超限独占一批） |
| 权重 | active 3 : background 1，批次后轮转起点 |
| 队列上限 | 每 lane 256；满时丢 delta 并标 `snapshotRequired`，终态不丢 |
| 合并 | delta 尾部字符串合并；snapshot 每 lane 只留最新 |

### 6.3 事件目录（按 `EventCatalog` 分组，节选核心）

| 域 | 事件（语义名 → 旧 fn） |
|---|---|
| 生命周期 | `tab.resync`→onTabResync、`session.bound`→setSessionId、`session.loaded`→historyLoadComplete、`session.cleared`→clearMessages、`command.rejected`、`attachment.failed`、`tab.create.requested`→createSessionTab、`tab.activated` |
| 回合 | `turn.started`→onStreamStart、`turn.ended`→onStreamEnd、`turn.settled`→onTurnEnd、`turn.retry`、`turn.error`、`turn.heartbeat` |
| 消息 | `content.delta`、`thinking.delta`、`thinking.status`、`message.snapshot`、`message.tail`、`message.prepended`、`message.added`、`message.history`、`message.removed`、`message.uuid.patched`、`message.block.reset` |
| 状态/用量 | `status.updated`、`session.loading`、`session.summary`、`usage.updated` |
| tab/设置 | `tab.title.changed`、`tab.state`→applyBackendTabState、`settings.mode`、`settings.mode.received`、`settings.model.confirmed`、`settings.*`（偏好类）、`agents.updated` |
| 提示 | `permission.requested`、`question.requested`、`question.answered`、`question.invalidated`、`plan.requested`、`prompt.closed`、`prompt.question.closed`、`prompt.plan.closed` |
| 状态面板 | `todos.updated`、`task.event`、`subagent.status`、`subagent.history`、`revert.changed`、`session.hydrated` |
| 窗口级 | `daemon.status`、`theme.*`、`font.*`、`cli.status`、`history.data`、`toast.*`、`selection.*`、`slash.commands` 等 |

> 完整 **140 项**以 `EventCatalog.java` 与 `utils/semanticEvents.ts` 双向对照为准；两侧必须保持同一份表（idea 有 `EventCatalogTest` 断言）。本仓库移植时同样加一条"两端目录一致"的测试。

**本仓库新增事件**（idea 没有，D1 需要）

| 事件 | 方向 | 载荷 |
|---|---|---|
| `tab.created` | H→W | `tabId, title`（视图新建本地 tab 记录；发起视图可幂等忽略） |
| `tab.closed` | H→W | `tabId`（其他视图移除该 tab） |
| `view.ready` | W→H | `viewId` |
| `view.focus` | W→H | `viewId, focused` |
| `view.navigate` | H→W | `view` |
| `prompt.host.changed` | H→W | `tabId, viewId` |
| `tab.draft.changed` | W→H→W | `tabId, draft` |
| `tab.reordered` | H→W | `tabIds[]` |

另外，`tab.activated` 在 idea 中是无参的窗口级事件；本仓库必须补 `tabId`（改为 `tab.activated {tabId}`），否则视图无法判断切到哪一个。

以上九项必须写入 `EventCatalog` 与 `semanticEvents`，避免再次出现"发明事件名"。

### 6.4 顺序与幂等

| 字段 | 来源 | 用途 |
|---|---|---|
| `seq` | core 从 `durable.seq` 透传 | 丢乱序 delta |
| `turnId` | 回合起始 seq | `(tabId, turnId)` 终态幂等 |
| `sequence` | 宿主 coalescer 每次推送自增 | `updateMessages` 新旧判定 |
| `baseIndex` | 窗口化消息起点 | 尾部替换/拼接 |
| `epoch` | tab 绑定/重绑递增 | 拒 rebind 前事件 |
| `generation`（本仓库新增） | 视图注册递增 | 拒视图重载前事件 |

`sequenceBarrier` 必须 per-session（未知 session 返回 0，`isForegroundSession(null)=false`），否则一个会话的高序号会永久卡死另一个会话的加载。

---

## 7. 新 UI 设计（多会话标签栏）

### 7.1 设计目标与约束

| 目标 | 约束 |
|---|---|
| 与 VS Code 原生标签观感一致 | 只用 `--vscode-*` 变量，不写死颜色 |
| 300px 侧栏可用 | 四档响应式 + compact 模式 |
| 后台会话可感知 | busy / attention 两种角标 |
| 全视图一致 | 切换、排序、标题、草稿同步；弹窗只在一个视图 |
| 不新增第二层导航 | 原生编辑器 tab 只代表视图，不再承载会话 |

### 7.2 布局（改造现有 ChatHeader）

```
┌──────────────────────────────────────────────────────────────┐
│ [tab A][tab B][tab C] …            [+] [⌕] [🕘] [⚙]         │ 36px
├──────────────────────────────────────────────────────────────┤
│                    消息区（仅渲染 activeTab）                 │
├──────────────────────────────────────────────────────────────┤
│                    输入区（草稿按 tab）                       │
└──────────────────────────────────────────────────────────────┘
```

**明确移除**（与现状对比）：

| 现状元素 | 处置 | 原因 |
|---|---|---|
| 头部中央会话标题 + 内联编辑 | 移除 | 标题在 tab 上，双击/F2 重命名 |
| 头部 share / copy link / unshare 按钮 | 移除 | 分享已下线（D8） |
| 头部 fork-all 按钮 | 移除 | 移入 tab 右键菜单（按 tab fork） |
| "更多"下拉里的导出/设置 | 导出移入右键菜单；设置改为右下直接按钮 | 与 idea 一致，减少层级 |
| 右侧 `+ / 搜索 / 历史 / 更多` | 改为 `+ / 搜索 / 历史 / 设置` | 与 idea 对齐 |
| 历史页 | 保持"返回"按钮 | 不变 |
| 设置页 | 不渲染 header | 不变 |

### 7.3 尺寸与视觉

| 元素 | 规格 |
|---|---|
| tab 项 | 高 28；圆角 6；内边距 `4px 8px`；gap 6；字号 12；`max-width` 见 §7.5 |
| 图标 | 13px codicon；idle `comment-discussion`；busy `loading`（旋转）；attention `warning`（琥珀脉冲） |
| 关闭按钮 | 16×16；默认 `opacity:0`；hover/active 显示；hover 变红底 |
| 容器 | `gap:4`；垂直 padding 4；横向滚动（隐藏滚动条） |
| 溢出按钮 | 26×26；`ellipsis`；右上角带 busy/attention 点 |
| 拖拽指示 | 2px 竖条 `--vscode-focusBorder`，脉冲 0.8s |
| 菜单 | 右键 200px / 溢出 220px；`max-height:320`；圆角 8；`--vscode-widget-shadow` |

**状态视觉**

| 状态 | 背景 | 前景 | 其他 |
|---|---|---|---|
| idle | 透明 | `--vscode-tab-inactiveForeground` | hover `--vscode-list-hoverBackground` |
| active | `--vscode-tab-activeBackground` | `--vscode-tab-activeForeground` | 底部 2px `--vscode-focusBorder` |
| busy | 同当前 | spinner 图标 | 可点击，不阻塞 |
| attention | 同当前 | warning + 脉冲 | `title` 追加"等待操作" |
| dragging | `opacity:.55` | — | `cursor:grabbing` |

> **不搬** idea 的 macOS Dock 悬浮放大（窄侧栏会遮挡相邻 tab，与原生手感不符）；改用 hover 底色 + 原生 tooltip。也**不搬** JCEF 的 `forceWebviewRepaint`/`surfaceDamagePulse`。

### 7.4 状态判定与优先级

```
attention > busy > idle
attention: TabPromptStore / TabRecord.pending > 0
busy:      该 tab 有活跃 turn（turn.started 未 turn.ended）
```

### 7.5 响应式四档

容器实测宽度 `W`（不含右侧图标区）：

| 档位 | 条件 | 可见 tab | `max-width` | 关闭按钮 | 说明 |
|---|---|---|---|---|---|
| 宽 | `W ≥ 520` | 按宽度计算，≥3 | 150 | hover/active | 编辑器面板 |
| 中 | `360 ≤ W < 520` | ≤3 | 110 | hover/active | 默认侧栏 |
| 窄 | `280 ≤ W < 360` | ≤2 | 96 | 仅 active | 小侧栏 |
| 紧凑 | `W < 280` | 1（active）+ 溢出 | 96 | 不显示 | 极窄 |

- 复用 `utils/tabPartition.ts` 的 `calculateVisibleCount` + `partitionTabs`，三档只改入参。
- **强制可见**：active tab 与刚拖出溢出菜单的 tab 永不被折叠；放不下时从尾部淘汰非强制 tab。

### 7.6 溢出菜单

- `⋯` 仅在容量不足时出现；右上角 busy/attention 点表示被折叠 tab 中有活跃/待办。
- 菜单项：状态图标 + 标题 + 关闭按钮；active 高亮。
- 支持拖拽出菜单（`pinnedTabId` 防回弹）。
- 键盘：↑/↓、Enter、Esc。

### 7.7 右键菜单（最终版，无分享）

| 分组 | 项 |
|---|---|
| 1 | 重命名（F2） |
| 2 | Fork 会话 / 导出 Markdown |
| 3 | 关闭其他 / 关闭右侧 / 关闭左侧 / 关闭全部 |

禁用规则：无 `sessionId` 时 Fork/导出禁用并给 tooltip；只剩一个 tab 时"关闭其他/左/右"禁用。

> 分享三项（分享/复制链接/关闭分享）在代码中保留 `SHARE_MENU_ENABLED = false` 与休眠实现，**不渲染**。

### 7.8 重命名

- 双击标题或 `F2` → 就地 input（当前宽度，`maxLength 50`）；Enter 提交 / Esc 取消 / 失焦提交。
- 提交：本地 `titleSource='user'` → `tab.title.set` → 宿主 `applyUserTitle` → 广播 `tab.title.changed{source:'user'}`。
- 服务端标题同步另走 `session.rename`（仅当已有 session）。
- 引擎自动标题（`tab.title.changed` 无 source）**不得覆盖** `titleSource=USER`。

### 7.9 拖拽排序

- 移动 >4px 进入拖拽；跟随元素 `position:fixed`、`z-index:10001`、`--vscode-widget-shadow`。
- 释放：`tab.reorder{tabIds}`（本仓库新增命令）→ 宿主保存 → 广播 `tab.reordered`（所有视图一致）。
- 拖到溢出按钮悬停 600ms 自动展开。

### 7.10 新建 / 关闭 / 最后一 tab

| 操作 | 行为 |
|---|---|
| `+` | `tab.create` → 宿主建空记录 → 广播 `tab.created` + `tab.activated` |
| 关闭 active | 激活右邻（无则左邻） |
| 关闭最后一个 | 立即新建空 tab（不恢复旧会话） |
| 关闭流式中 tab | 先 `session.interrupt`，前端即刻清 loading，再释放 |
| 关闭视图 | 不动 tab |

关闭命令的所有权与 idea 一致：`tab.close` 在宿主只做删除并广播 `tab.closed`，**宿主不补建 tab、不代选 next active**；补建由发起视图发 `tab.create`（最后一个 tab 关闭时），next active 由发起视图发 `tab.activate`。宿主在 `tab.close` 里补建会与视图的补建并存，导致「关闭全部」后前台出现两个空白会话。

### 7.11 多视图与弹窗

- 宿主维护 `activeViewId`（聚焦 > 最近可见 > 主侧栏）。
- `permission.requested` 广播给所有视图；只有 `viewId === promptHostId` 渲染模态，其余仅更新 tab 角标。
- 焦点变化 → `prompt.host.changed` → 旧视图收起（保留 pending），新视图弹出。
- 无可见视图时 prompt 留在宿主队列，下次 `view.ready` 后弹出。

### 7.12 主题变量映射

| 语义 | 变量 | 兜底 |
|---|---|---|
| 容器背景 | `--vscode-sideBar-background` / `--vscode-editor-background` | `#1e1e1e` |
| active 背景/前景 | `--vscode-tab-activeBackground` / `--vscode-tab-activeForeground` | `#1f1f1f` / `#fff` |
| 非活动前景 | `--vscode-tab-inactiveForeground` | `#9d9d9d` |
| 强调条/焦点 | `--vscode-focusBorder` | `#007acc` |
| hover | `--vscode-list-hoverBackground` | `rgba(255,255,255,.06)` |
| attention | `--vscode-editorWarning-foreground` | `#cca700` |
| busy | `--vscode-progressBar-background` | `#0e639c` |
| 菜单 | `--vscode-menu-background/foreground/border/selectionBackground` | `#252526/#ccc/#3c3c3c/#094771` |
| 阴影 | `--vscode-widget-shadow` | `rgba(0,0,0,.36)` |
| 危险 | `--vscode-errorForeground` | `#f14c4c` |

高对比度主题存在 `--vscode-contrastBorder` 时优先使用。

### 7.13 i18n（新增/复用 key）

| key | 中文 | English |
|---|---|---|
| `common.newSession` | 新建会话 | New Chat |
| `common.pendingApproval` | 等待操作 | Waiting for you |
| `common.moreSessions` | 更多会话 | More sessions |
| `chat.renameSession` | 重命名 | Rename |
| `chat.forkSession` | Fork 会话 | Fork session |
| `chat.exportMarkdown` | 导出为 Markdown | Export as Markdown |
| `chat.closeOtherTabs` | 关闭其他标签页 | Close other tabs |
| `chat.closeTabsToRight` | 关闭右侧标签页 | Close tabs to the right |
| `chat.closeTabsToLeft` | 关闭左侧标签页 | Close tabs to the left |
| `chat.closeAllTabs` | 关闭所有标签页 | Close all tabs |
| `chat.tabBusy` | 正在生成 | Generating |
| `chat.tabWaiting` | 有请求等待处理 | Action needed |
| `chat.sendFailedNoTab` | 发送失败：找不到当前标签页 | Send failed: no tab |

删除：`chat.shareTooltip`、`chat.copyShareLinkTooltip`、`chat.unshareTooltip`、`chat.sharePendingTooltip`（本仓库实际存在的 4 个分享文案）、`settings.basic.newSessionConfirm.*`、`chat.confirmNewSession`、`history.convertToCliSession` 及其错误码。idea 侧独有的 `chat.shareSession` / `chat.copyShareLink` / `chat.unshareSession` / `chat.shareNeedsSession` 在本仓库不存在，不要新增。

### 7.14 快捷键与无障碍

| 键（输入框未聚焦时） | 行为 |
|---|---|
| `Alt+T` | 新建 tab |
| `Alt+W` | 关闭当前 tab |
| `Alt+1…9` | 切换第 N 个 |
| `Alt+←/→` | 上一个/下一个 |
| `F2` / `Delete`（tab 聚焦） | 重命名 / 关闭 |

- `role=tablist` / `role=tab` / `aria-selected` / `aria-controls`。
- `Home/End/←/→/Enter/Space` 键盘遍历；焦点环用 `--vscode-focusBorder`。
- busy/attention 写入 `aria-label`。

### 7.15 视觉验收

| # | 场景 | 通过标准 |
|---|---|---|
| 1 | 300px / 5 tab | 2 可见 + 溢出，active 不被折叠 |
| 2 | 200px | compact：active chip + `⋯N` |
| 3 | 1200px / 10 tab | 6+ 可见，拖拽排序全视图同步 |
| 4 | 后台流式 | 转圈只在对应 tab |
| 5 | 后台权限 | 琥珀脉冲；切过去弹窗出现 |
| 6 | 两视图同开 | tab/active/标题/草稿一致；弹窗唯一 |
| 7 | 重命名 | 自动标题不覆盖用户标题 |
| 8 | 深/浅/高对比 | 无硬编码颜色 |
| 9 | 键盘 | 全部可达 |
| 10 | 关闭最后 tab | 立即出现空 tab |

---

## 8. OpenCode v1 / v2 兼容

### 8.1 链路

```
设置（Memento: opencode.tuiPath）
  → 宿主 CliSpecResolver：绝对路径，不探测版本
    → 注入 OPENCODEBUDDY_CLI_PATH / OPENCODEBUDDY_NODE_BIN(process.execPath) / OPENCODEBUDDY_CONFIG_DIR
      → core cli-resolver（L0→L4）→ engine-probe（/api/info、/global/health）
        → engine-registry（pending|v1|v2|unknown，验证通过才锁）
          → engine_status → 宿主快照 → daemon.status.payload.engine → UI
```

### 8.2 宿主改动

| 项 | 目标 |
|---|---|
| env | `OPENCODEBUDDY_CLI_PATH`（设置原值，L0 无效即阻断）+ `OPENCODEBUDDY_NODE_BIN=process.execPath` + `OPENCODEBUDDY_CONFIG_DIR`；保留 `OPENCODE_BIN` 兼容 |
| 事件 | `handleDaemonEvent` 增 `engine_status`；`ready` 头字段折叠为初始快照；daemon 重启清空 |
| 载荷 | `DaemonStatusPayload` 增 `engine`；**保留** `phase/code/detail/installCmd`（VS Code 版优于 idea，不回退） |
| 校验 | 设置保存时 `existsSync` 校验 CLI 路径（VS Code 无 WSL 命名空间问题，比 idea 更严） |

### 8.3 UI

- `useUsageTracking.daemonEngine` 接收 `engine`；`unknown`/`blocking` 时 `StatusNoticeBar` 出可操作告警（重新检测 / 打开设置 / 查看日志）。
- 环境设置页展示：opencode 路径、来源、CLI 版本、引擎模式；**不展示 Node 路径**。
- 诊断复制：路径 + 版本 + engine 快照。

### 8.4 发布链

1. core tag `v1.0.0`（已含身份信封、`[TURN_END]`、引擎注册表）。
2. `package.json` 依赖改 `github:SenjuObito/opencode-buddy-core#v1.0.0`。
3. `tools/prepare-core.mjs` 版本解析跟随。
4. `pnpm run unlink:core` → `pnpm run package` 验证；CI 禁止 link 状态。

---

## 9. 平台差异与不搬清单

| 维度 | idea | VS Code | 处置 |
|---|---|---|---|
| 渲染桥 | JCEF `executeJavaScript` + raw script | `postMessage` | 保留 lane/合并/预算，传输替换 |
| 帧治理 | `SurfaceFrameFence` / OSR / watchdog / `surfaceDamagePulse` / `forceWebviewRepaint` | 无 | **不搬**，替换 webview 时剔除调用点 |
| 线程 | EDT / CEF IO / 池线程 | Node 事件循环 | actor 用 Promise 链 |
| Node | `NodeDetector` + node 路径设置 + 进程管理 | `process.execPath` | **不搬**（含 `node.path` / `node.processes` / `kill_*` / `diagnostics.nodeProcesses.*`） |
| 持久化 | `PersistentStateComponent`（`TabStateService` 仅 tab 名/数量） | `Memento` | 不恢复 tab；设置保留 |
| 字体 | IDE/UI/Code 三套 + 系统字体列表（`font.idea`、`language.apply`） | 编辑器字体同步 | **不搬** |
| 状态栏/提交/提示词增强 | 宿主事件 `settings.statusbar.*` / `settings.commit.*` / `settings.prompt.enhancer` | 现有设置实现 | 保留 VS Code 现状 |
| 命令管理（PromptSection） | ✅ | ❌ | **不搬** |
| 容器 | ToolWindow Content/tab | WebviewView / WebviewPanel | 统一为视图（D1） |
| 多视图 | 不存在 | 存在且共享 | 新增 `ViewRegistry` + resync + 草稿同步 |

---

## 10. 功能域迁移规格（14 项）

> 本章回答"每个用户可见功能具体改哪里、验收什么"。
> 与 §11 的文件分类配合使用：A 类照搬的文件直接服务本章，B 类合并按本章逐项验收。
> 每项标注 **VS Code 现状 → idea 落点 → 迁移动作 → 验收 → 陷阱**。

### 10.1 启动页与首帧（Boot Splash）

| 项 | 内容 |
|---|---|
| 现状 | `webview/index.html` 只有主题脚本，`#app` 在 React 挂载前是空白；`buildWebviewHtml` 注入主题/偏好但不设底色 → 冷启动白闪（暗色主题最明显） |
| idea 落点 | `AeroLoadingPanel.java`（Java2D 原生，**不搬**）、`HtmlLoader.injectIdeTheme`、`index.html` 内联深色底、`ErrorPanelBuilder` |
| 迁移动作 | 1) `buildWebviewHtml` 注入 `<style>`：`html,body,#app{background:var(--vscode-sideBar-background)}`；2) `#app` 内置 `#boot-splash`（内联 Aero 标记 SVG + 环形微动效）；3) `main.tsx` 首个 commit 后移除 splash；4) 加载失败渲染静态错误页而不是空白 |
| 验收 | 冷启动无白闪；首帧即深色；logo 首帧可见；`prefers-reduced-motion` 下无动画；失败有可读文案 |
| 陷阱 | 不要写死 `#121317`（必须跟随主题）；不要新增内联 `<script>`（继续用现有主题脚本 + React 移除） |

### 10.2 插件图标与品牌资源

| 项 | 内容 |
|---|---|
| 现状 | `media/opencode.png`、`opencode.svg`、`opencode-activity{,-dark,-light}.svg`；活动栏是旧方块字形 |
| idea 落点 | `META-INF/pluginIcon.svg`（512）、`icons/opencode-icon{,_dark}.svg`（24 viewBox）、`logo-16/logo-16@2x/logo.png`；`webview/components/shared/AeroOpenCodeLogo.tsx` + `ProviderModelIcon` |
| 迁移动作 | 1) 由 idea 512 SVG 导出 `media/opencode.png`；2) 生成活动栏单色版（`currentColor`，暗/亮各一）；3) `package.json` 的 `icon` 与 `viewsContainers` 图标更新；4) `WebviewPanel.iconPath` 按主题；5) webview 内品牌位改用 `AeroOpenCodeLogo`（A 类照搬） |
| 验收 | 市场页 / 活动栏 / 面板标签 / 欢迎页同一套标记；16px 可辨；暗亮主题各一版；高对比度不丢轮廓 |
| 陷阱 | 活动栏图标必须单色（VS Code 会着色）；彩色 Aero 只能用于 webview 内，不能直接当活动栏图标 |

### 10.3 新会话默认背景（Empty State）

| 项 | 内容 |
|---|---|
| 现状 | `welcome.less` 只有基础居中；`ChatScreen` 无空态 shell；新会话是纯色平铺 |
| idea 落点 | `welcome.less` 的 `.chat-screen-shell` + `.is-empty-state`（径向极光 + 20px 点阵，含 light 变体）；`ChatScreen.tsx:232` `isEmptyState = !sessionLoading && mergedMessages.length===0`；`WelcomeScreen` + `AnimatedText` |
| 迁移动作 | 移植 shell/空态样式与 light 变体；`ChatScreen` 按 activeTab 计算空态并加 class；WelcomeScreen 布局对齐 |
| 验收 | 空 tab 显示背景 + 微光 + logo + 提示；首条消息发出后背景消失；切 tab 各自正确；亮色主题不刺眼 |
| 陷阱 | 背景只挂在 empty state，不要挂到 `body`（会污染历史/设置页） |

### 10.4 模式列表（Agents / permissionMode）

| 项 | 内容 |
|---|---|
| 现状 | `providers/agentProvider.ts` 模块缓存 + `get_agents` / `updateAgents`；`ModeSelect` 读同步缓存；无自定义配色 |
| idea 落点 | `store/agentStore.ts`（`agents.updated` 推送 + `useSyncExternalStore` + `requestAgents`）；`ModeSelect` 用 store + `FALLBACK_PRIMARY_AGENTS`；`utils/modeColors.ts`（agent.color） |
| 迁移动作 | 移植 `agentStore` + `modeColors`；`AgentHandler` 在 `view.ready` 与目录变更后推 `agents.updated`；`ModeSelect` 改为订阅 store；保留 per-tab `permissionMode` |
| 验收 | 列表来自宿主；自定义 agent 即时出现；颜色正确；无推送时回退 build/plan；A/B 模式独立；切 tab 不重置 |
| 陷阱 | 禁止在 webview 伪造完整列表（只允许两档 fallback）；agent id 必须与 opencode 一致（`build`/`plan`） |

### 10.5 模型列表与置顶

| 项 | 内容 |
|---|---|
| 现状 | `useCliModels` + `get_cli_models` + `updateCliModels`；`ModelSelect` 分组/搜索；`pinned_models` 点击置顶；`useModelStatePersistence` |
| idea 落点 | 同一数据链 + **置顶拖拽排序**（长按 180ms、Dock 风格、portal 下拉、`writePinnedModelIds`）；`models.list`；模型上下文目录 |
| 迁移动作 | 保留 VS Code 数据链，移植拖拽排序与 portal；置顶写回 `settings.pinned.models`；新 tab 默认首选置顶；`selectedModel` 入 tab；首发送携带 model |
| 验收 | 列表/搜索/分组正常；拖拽排序持久化；不同 tab 不同模型；刷新后恢复；空目录有回退 |
| 陷阱 | 模型拖拽与 tab 拖拽手势冲突（不同容器 + `stopPropagation`）；模型 id 不要二次拼 `provider/` |

### 10.6 推理力度（variants）

| 项 | 内容 |
|---|---|
| 现状 | `ReasoningSelect` 已按 `modelVariants` 显示；`reasoningUtils.ts` 已有 `useReasoningEffortGuard`，但 `ReasoningSelect` 未使用它，"档位失效自动回落"未生效 |
| idea 落点 | `components/ChatInputBox/reasoningUtils.ts`（`useReasoningEffortGuard`、`resolveCurrentReasoningLevel`）；`getAvailableReasoningLevels` 单一实现 |
| 迁移动作 | 移植 guard；effort 入 tab（`TabRecord.settings` / `SessionTabData.reasoningEffort`）；发送带 effort；切模型时不可用档位回落 `default` |
| 验收 | 切模型档位联动；不支持时隐藏选择器；A/B 独立；`none/default/minimal` 文案正确；首发送生效 |
| 陷阱 | 不要用全局 effort 覆盖其他 tab；`xhigh/max` 只在 variants 出现时展示 |

### 10.7 权限弹窗

| 项 | 内容 |
|---|---|
| 现状 | `PermissionHandler` 用 `channelId` 索引 pending，`request.sessionId ?? context.getSession()` 借会话；`PermissionDialog.tsx` 307 行；单模态 |
| idea 落点 | `prompt/PromptBroker`（permission/question/plan 三表 + tab/session 归属）；`PermissionHandler.showPermissionDialog(request, targetSessionId)`；`permission.requested {tabId, sessionId, requestId, data}`；后台 tab 队列 + 角标 |
| 迁移动作 | 实现 `PromptRegistry`；dialog 增加 `tabId/sessionId/requestId`；回复 `permission_decision` 三重校验；`prompt.closed` 只按 requestId 移除；超时只拒绝当前 |
| 验收 | 后台请求切过去可见；两 tab 同时请求互不覆盖；批准/拒绝只作用于目标；超时只关当前；关闭 tab 拒绝本 tab |
| 陷阱 | `channelId`（call_*）≠ `permissionId`（per_*）；回复必须用 `per_*`；禁止 `?? getSession()` |

### 10.8 问题弹窗（Ask User Question）

| 项 | 内容 |
|---|---|
| 现状 | `AskUserQuestionDialog.tsx` 387 行；提交走 `ask_user_question_response`；`questionAnswerStore` 已引入但未接事件与答案卡 |
| idea 落点 | `store/questionAnswerStore.ts`（callId 索引）；`question.answered` / `question.invalidated`；`QuestionAnswerSummary.tsx`（227 行，答案卡）；超时回调 |
| 迁移动作 | 移植 store 与事件；dialog 增加 tab 身份与 `onTimeout`；提交/取消分别走 response/reject；答案卡按 callId 渲染 |
| 验收 | 单选/多选/取消正常；答案卡落到对应 tool_use；后台会话只显示角标；超时自动关闭；多会话不串 |
| 陷阱 | `questions` 可能是 string/object/array（需归一化）；不要用 `requestId` 当 `callId` |

### 10.9 状态面板（任务 / 子代理 / 编辑）

| 项 | 内容 |
|---|---|
| 现状 | `StatusPanel.tsx` 334 行，展开/子页是组件本地 state；`useSubagents` 自带三套状态判定；undo 走 `window.onUndoFileResult` |
| idea 落点 | 面板状态入 tab（`statusPanelExpanded` / `statusPanelTab`）；`todos.updated` / `task.event` / `subagent.status` / `subagent.history` 按 tab 路由；`resolveSubagentRunState` 统一 v1 `task` 与 v2 `subagent`；`files.undo` / `files.undo.all` 事件化；毛玻璃胶囊样式 |
| 迁移动作 | 面板状态入 `TabStore`；事件路由按 tab；统一子代理状态函数；transcript 按需加载（上限 50）；undo 事件化 |
| 验收 | A/B 并行 todo/subagent/edit 不串；切 tab 恢复展开与子页；子代理 transcript 正确；undo 只影响目标；长列表不卡 |
| 陷阱 | 子代理终态不能被迟到的 `running` 覆盖；transcript 必须有上限；所有更新带 sessionId 过滤 |

### 10.10 添加附件

| 项 | 内容 |
|---|---|
| 现状 | `useAttachmentHandlers` / `useAttachmentPersistence`（localStorage 草稿，2MB 上限）+ 单帧 base64 `send_message_with_attachments` |
| idea 落点 | `utils/attachmentTransport.ts`（24KB/块）+ `AttachmentHandler`（prepare/chunk/complete/abort）+ `TabAttachmentStore`（32MB，按 tab 临时目录）+ 切 tab 恢复 |
| 迁移动作 | 移植 transport（VS Code 96KB/块）；host 落盘 `globalStorageUri/attachments/<tabId>/`；`session.send.attachments` 只带 id/文件名/类型；tab 关闭 `release()` |
| 验收 | 10MB 图片可发且不卡；A/B 附件不串；切 tab 恢复；关闭释放临时文件；超 32MB 明确报错；粘贴/拖拽/选择三入口一致 |
| 陷阱 | 不要把 base64 写 localStorage（配额）；分块必须按 offset 顺序；`complete` 之前不得发送 |

### 10.11 引用文件（`@`）

| 项 | 内容 |
|---|---|
| 现状 | `fileReferenceProvider` 发 `list_files`、收 `window.onFileListResult`；`useFileTags` 渲染 chip；没有"恢复草稿时重建 chip"的能力（只回填原始文本会退化为纯文本） |
| idea 落点 | `files.listed` 事件；`useFileTags.restoreFileTags(tags)`（重建路径映射 + chip）；按 tab cwd 列举；`fileTags` 随 send |
| 迁移动作 | `files.listed` 事件化；host 用目标 tab 的 cwd；接入 `restoreFileTags`；路径空格/中文引用格式统一 |
| 验收 | 两 tab 不同 cwd 候选不同；切 tab chip 仍可发送；服务端收到绝对路径；同名文件不歧义 |
| 陷阱 | 不要把 `displayPath` 当绝对路径；`@` 请求必须带 requestId 防乱序 |

### 10.12 文件上下文（Context Bar）

| 项 | 内容 |
|---|---|
| 现状 | `EditorContextTracker` 广播 `addSelectionInfo` / `clearSelectionInfo`；`ContextBar` 展示；无 per-tab 开关；webview 已发 `context.refresh` 但宿主无 handler（断链） |
| idea 落点 | `context.refresh {enabled}` per tab；`TabSettings.contextEnabled`；发送时 `buildSessionContextAppend(openedFiles, fileTagPaths)`；`context.updated` |
| 迁移动作 | 开关入 tab；发送时按目标 tab 注入；关闭开关立即清空；`autoOpenFileEnabled` 入 tab |
| 验收 | A 开/B 关时发送内容不同；切 tab 恢复；选区/文件插入正确；关闭后不注入 |
| 陷阱 | 编辑器上下文是窗口级（同一份），"是否注入"是 tab 级；不要存进全局设置 |

### 10.13 执行 bash 命令（`!`）

| 项 | 内容 |
|---|---|
| 现状 | `SessionHandler` 检测 `text.startsWith('!')` → `session.sendShell(command, cwd)` → core `opencode.shell`；乐观用户气泡 |
| idea 落点 | `SessionHandler` 用目标 tab 的 session/cwd；`OpencodeSession.sendShell(finalPrompt, command)` 保留展示文本；`normalizeUserShellPrompt` 兼容 `!bash pwd` |
| 迁移动作 | 按 tab 解析目标；保留 `!cmd` 展示；输出作为 bash 工具结果入对话；错误/中断只影响目标 |
| 验收 | `!ls` 只影响目标 tab；输出进对话并触发 AI 回复；`!bash pwd` 识别；失败提示；停止按钮生效；A/B 并行不串 |
| 陷阱 | 不要把 `!` 内容当 prompt 发给模型；cwd 必须取 tab 的 |

### 10.14 执行 opencode 命令（`/`）

| 项 | 内容 |
|---|---|
| 现状 | `OpenCodeSession.send` 已解析 `/name args` → core `session.command`；命令列表由 `updateSlashCommands` 推送；`refresh_slash_commands` 是窗口级 |
| idea 落点 | `commands.refresh` 按 tab（cwd）；`SlashCommandRegistry` 合并内置 + skills + commands；命令不注入上下文/agent prompt；内置 `/new /resume /plan /context /compact /undo /redo /fork` |
| 迁移动作 | 命令列表按 tab 刷新与缓存；移除 `/share`、`/unshare`（已下线）；`/plan` 映射到 agent/permissionMode；保留 core command 发送路径 |
| 验收 | `/name` 走 command 端点且不带上下文；列表随 cwd；内置命令本地执行；未知命令回退普通消息；分享命令不存在 |
| 陷阱 | 别把 slash 命令当普通 prompt（会注入上下文/agent role）；`/v2/...` 这类路径不能被误判为命令 |

---

## 11. 迁移策略（关键：不要整树覆盖）

### 11.1 为什么不整树覆盖

- idea webview 里有 36 个本仓库没有的源码文件，其中 6 个是 IDEA-only 功能（命令管理 `PromptSection`、`modeColors`、`MessagesErrorBoundary`、`AeroOpenCodeLogo`）；
- 159 个分叉源文件里，有相当一部分差异来自 **idea 独有功能**（分享、PromptSection、节点进程、JCEF 重绘），整树覆盖会把这些变成"有 UI 无后端"的死入口；
- 反向地，本仓库有 idea 没有的能力（`DaemonStatus` 失败分类、`verboseDiagnostics`、`convert_to_cli_session` 待删），整树覆盖会静默丢失；
- 覆盖后 `git diff` 无法区分"架构迁移"与"功能回退"，出问题无法按阶段回滚。

### 11.2 文件四类处置

| 类 | 判定 | 数量（webview src） | 做法 |
|---|---|---|---|
| **A 直接照搬** | idea 独有且纯架构、零 VS Code 依赖 | 30（其中 3 个需小改） | 复制 + 改 import + 补测试 |
| **B 三方合并** | 同名分叉，且差异含本次架构改造 | 约 25（重） | 见 §11.3 |
| **C 保持不动** | 同名分叉但差异与本次无关（样式、版本、功能修补） | 约 134 | 不做无意义合并 |
| **D 删除/不搬** | IDEA-only 或 VS Code 遗留死功能 | 见 §9 / §5.5 | 按清单 |

**A 类清单（30）**：`store/{tabStore,tabMessageStore,tabDraftStore,tabPromptStore,tabStatusStore,tabTransitionStore,tabRuntime,agentStore}.ts`（8；`questionAnswerStore.ts` 两仓已有，不属新增）、`hooks/sessionTabs/{types,useTabBarState,useTabLifecycle,useTabSessionBinder}.ts`（4）、`hooks/useSessionTabs.ts`（1）、`components/ChatHeader/{SessionTabBar,SessionTabContextMenu,types}.ts(x)`（3）、`utils/{hostDispatcher,hostEventRegistry,hostEventTypes,semanticEvents,sessionIdentity,tabPartition,attachmentTransport,revertStateEvent,sessionTitle}.ts`（9）、`hooks/windowCallbacks/{sequenceBarrier,tabTransition,resetTransientState}.ts`（3）、`test/{seedTabStore,testEvents}.ts`（2）。
其中需要小改的 3 个：`SessionTabContextMenu`（关闭分享分组）、`hostDispatcher`（新增 `host.events` 批量入口）、`attachmentTransport`（VS Code 分块大小，见 §11.5）。`sessionIdentity` 的 `cardDebugLog` 直接可用。

**B 类重点文件（按 diff 规模）**：`messageCallbacks`、`App.tsx`、`header.less`、`streamingCallbacks`、`registerCallbacks`、`global.d.ts`、`ChatHeader`、`main.tsx`、`useSessionManagement`、`sessionCallbacks`、`useDialogManagement`、`MessagesContext`、`permissionCallbacks`、`useStreamingMessages`、`utils/bridge.ts`、`useMessageSender`、`useHistoryLoader`、`useScrollBehavior`、`ChatScreen`、`useUsageTracking`、`i18n/*`。

### 11.3 B 类合并流程（每个文件一遍）

1. 以**本仓库当前文件**为基线（保住 VS Code 功能）；
2. 用 idea 版本做参考，只取**架构相关段落**：tab 身份参数、store 写入、事件注册、resync、per-tab 状态；
3. 明确保留本仓库独有段落（daemon 失败分类、`verboseDiagnostics`、VS Code 专属设置）；
4. 改完立即跑该文件的现有测试 + `tsc`；
5. 在实施记录里登记：文件、取用段落、保留段落、丢弃段落。

### 11.4 反模式（评审时逐条检查）

| 反模式 | 后果 |
|---|---|
| 直接 `cp -r` 整个 `webview/src` | 死 UI、功能回退、diff 不可读 |
| 复制 useSessionTabs 但继续保留 `create_new_session` | 双路径，会话被旧逻辑销毁 |
| webview 从 `window.onContentDelta` 单参继续写 | 身份丢失，串会话 |
| 宿主 `callJavaScript('updateMessages', json)` 直发 | 绕过 lane/批量/身份 |
| 权限 handler 保留 `?? context.getSession()` | 弹窗错归属 |
| 用 `activeTabId` 解析命令目标 | B 被 A 的操作影响 |
| 把 `tabStatusStore` 快照交换保留到多视图 | 两个视图状态分叉 |
| 在 `TabEvent` 里塞 `data` 字符串再前端二次 `JSON.parse` | 双重转义（已踩过一次） |
| 忘记给 webview 发 `tab.resync` | 侧栏隐藏后重建 → 只剩空 tab |

### 11.5 附件分块适配（B 类 `attachmentTransport`）

| 项 | idea（JCEF 帧预算 32k） | 本仓库（postMessage） |
|---|---|---|
| 分块大小 | `ATTACHMENT_CHUNK_CHARS = 24KB`（base64 字符，4 的倍数） | 96KB/块（单帧上限 1MB） |
| 上限 | `MAX_ATTACHMENT_BYTES = 32MB` | 同为 32MB |
| 落盘 | `TabAttachmentStore` 按 tab 建目录 | `globalStorageUri/attachments/<tabId>/`，tab 关闭时 `release()` |
| 命令 | `attachment.prepare/chunk/complete/abort` | 同名（顺序与语义一致） |
| 发送 | `session.send.attachments` 只携带 `attachmentId`/文件名/类型 | 同 |

理由：多视图下两个视图可能同时选文件；按 tab 归属 + 宿主持有字节，才能保证"谁选的附件进谁的会话"，也避免大 base64 挤占 delta lane。

---

## 12. 阶段计划

> **当前进度**：P0–P7 架构主干已落地（见 `docs/migration-progress.md`）；P8 的 14 项功能域多数未完成，P9 未终验。本章为完整目标计划，不表示已完成。

| 阶段 | 交付 | 工期 | 验收 |
|---|---|---|---|
| **P0 基线** | 协议/ID/所有权冻结；`src/host/tab` 骨架；grep 护栏（`create_new_session`、`switch_session`、`getSession()` 新增用量、单参 `onContentDelta`）；`EventCatalog` 双向一致性测试骨架 | 0.5d | core `npm test` 绿；`pnpm run compile` 绿 |
| **P1 core + 引擎** | pin `v1.0.0`；L0 env；`engine_status`；`daemon.status.engine`；环境页/告警条 | 1.5d | v1/v2/未装 三态正确；无效路径阻断 |
| **P2 宿主 Tab 内核** | `TabId/SessionId/TurnId/TabState/TabSettings/TabRecord/TabRegistry/TabSessionActor/TabSessionFactory/PendingSend/TabStreamRouter/TabCommandRouter` | 3d | 创建/绑定/关闭；A/B 并行不串；`unattributed=0` |
| **P3 单实例多视图** | `ChatWindow` / `ViewRegistry` / `TabEventRouter` / `PromptRegistry`；`extension.ts` 单窗口；视图 resync | 2d | 左右栏 + 面板同 tab 列表；切换全视图同步；视图重建恢复 |
| **P4 协议 v2** | `HostCommand`；入站批量；`vscodeBridge` batch；删除会话级广播；真实命令/事件目录对账 | 1.5d | 协议单测；`command.rejected`；无 handler 命令检测为 0 |
| **P5 webview A 类引入** | 30 个架构文件 + 类型 + store 测试 | 2d | `tsc` + 新增 store 测试绿；不影响现有单会话路径 |
| **P6 webview B 类合并** | 25 个重点文件按 §11.3 合并；删除清单落地 | 4d | 单会话行为不回退；`getSession()` 在 webview 归零 |
| **P7 多会话 UI** | tab 栏 + 四档响应式 + 菜单 + 拖拽 + 快捷键 + i18n | 3d | §7.15 十项 |
| **P8 功能回归** | 按 §10 逐项：启动页/图标/空态背景、模式/模型/推理力度、权限/问题弹窗、状态面板三子页、附件/引用文件/文件上下文、bash `!`、opencode `/`、fork/revert/compact、分享入口隐藏核对 | 5d | §10 各节验收 + 功能矩阵"只影响目标 tab" |
| **P9 生命周期+性能+发布** | resync、daemon 重启、释放清单、lane 预算、基准、core pin 打包验证 | 2d | reload 流式恢复；1000 次开关无泄漏；6 tab/3 流达标 |
| **P10 旧回调总线退场** | 见 §5.6：A 删 43 条死 legacy 投递（`TabEvent.legacy` 默认 `false` + 删 `TabEventRouter` fallback 循环 + 护栏）；B 窗口级功能迁 v2 后删 `window.<fn>` / `callJavaScript` / `createLegacyTarget` | 0.5d + 1.5d | 护栏 grep 绿；`eventCatalogParity` 绿；宿主 + webview 全量单测绿；VS Code 通道无 `{type:'onXxx'}` 报文 |

合计约 **26.5 人日**（"逐文件合并" + "多视图一致性" + "14 项功能域验收" + "P10 2 人日"）。

---

## 13. 测试矩阵

| 层 | 用例 | 命令 |
|---|---|---|
| core | 引擎解析 / 身份信封 / 共享查询路由 / 终态 | `cd ../opencode-buddy-core && npm test` |
| 宿主 | `tabRegistry`（绑定原子性/跨 tab 拒绝/关闭幂等）、`daemonEnvelopeRouting`（session→sink、bootstrap→requestId、orphan 计数、查询不被吞）、`turnEndIdempotency`、`promptIdentity`（三重校验）、`forkIsolation`、`viewResync`、`multiViewBroadcast`、`eventCatalogParity` | `pnpm run compile` + `vscode-test` |
| webview | 照搬：`sessionIdentity`(6)、`turnEnd`(7)、`useSessionTabsMultiSession`(11)、`permissionPromptRouting`(13)、`messageCallbacks.historyRouting`(7)、`hostDispatcher`、`tabPartition`、`tabStore/tabMessageStore`、`sequenceBarrier`；新增：`tabDraftSync`、`promptHostElection`、`tabResponsive`、`twoViewConvergence` | `cd webview && pnpm test` |
| 端到端 | 2 视图 + 3 tab + 2 并发流；视图关闭重开；关最后一个 tab；daemon 重启；v1/v2 各一遍 | 手工 + 脚本 |

**功能矩阵判据**：每个操作只影响目标 tab；后台 tab 的终态清理自己的 loading；跨视图同屏一致。

---

## 14. 风险与回滚

| 风险 | 缓解 |
|---|---|
| B 类合并把 VS Code 功能改丢 | 每文件合并后跑该文件测试 + 在实施记录登记保留段落 |
| 多视图状态分叉 | INV-9：单一写入方；`twoViewConvergence` 测试；禁止 React state 与 store 双写 |
| 草稿互相覆盖 | 去抖 + 聚焦视图优先 |
| 弹窗多视图重复 | `promptHostId` 选举 + 焦点事件 |
| 大快照卡顿 | lane 预算 + `message.tail` + `sequence/baseIndex` |
| 视图销毁导致会话"消失" | registry 常驻 + `view.ready → tab.resync`；P3 先于 P7 |
| 旧命令残留 | 护栏 grep + "发送了但无 handler"测试 |
| core pin 漏更新 | P1 / P9 各验证一次 `unlink:core` 打包 |
| 分享入口复活 | `SHARE_MENU_ENABLED=false` 常量 + 验收项检查 |
| 回滚 | P1 独立；P2–P4 同退（协议耦合）；P5/P6/P7 独立；P8 按功能域 |

---

## 15. 文档处置

- 本文为唯一权威方案，已删除：`multi-tab-and-opencode-v2-sync-plan.md`、`multi-tab-and-session-isolation.md`、`opencode-v2-adaptation-guide.md`、`opencode-v2-compatibility-analysis.md`。
- 实施进度与逐项状态维护在 `docs/migration-progress.md`（每完成一项更新该文档，不改本文的目标态描述）。
- 实施后需增量更新：`permission-and-question-flow.md`、`undo-redo-and-fork-flow.md`、`opencode-serve-process-management.md`、`input-commands-and-mentions.md`。
- 日志统一带 `tabId` / `sessionId` / `viewId`；排查入口见 `docs/log.md`。
- `opencode-idea-gui/webview/src/ARCHITECTURE.md` 已过期（仍描述单会话 + claude/codex），**不得作为参考**。
