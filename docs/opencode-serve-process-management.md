# opencode serve 进程管理流程梳理

> 目的：回答「opencode serve 进程挂了之后，有没有重启拉起操作」以及「server 进程管理的完整流程」。
> 结论先行：**opencode serve 子进程挂掉后，没有专门的自动重启拉起机制。** 唯一能让 serve 重新拉起的路径，是「整个 daemon 进程（ai-bridge/daemon.js）死掉 → 宿主侧自动重启 daemon → 连带重新 spawn serve」。若 daemon 进程还活着、只是它内部 spawn 的 serve 子进程挂了，则不会自动恢复。

---

## 一、进程层级（从上到下）

```
VS Code Extension Host (宿主)
 └─ OpenCodeDaemonBridge            ← 管理 daemon.js 进程，有自动重启
     └─ ai-bridge/daemon.js         ← 常驻 Node 进程（danemon 进程本身）
         └─ opencode serve --port N ← 由 serve-manager 在内部 spawn 的子进程
```

关键点：**自动重启只发生在第一层（daemon.js 进程），不在第二层（serve 子进程）。**

---

## 二、各层职责与关键代码

### 第 1 层：宿主管理 daemon.js 进程（会自动重启）
文件：`src/host/provider/OpenCodeDaemonBridge.ts`

- `startHeartbeat()`（L604-643）：每 `HEARTBEAT_INTERVAL_MS` 探测一次，若 `exitCode !== null` 或决策为 `DECLARE_DEAD`（无响应），调用 `handleDaemonDeath()`。
- `startReader()` 的 `rl.on('close')`（L587-591）：daemon 进程 stdout EOF → `handleDaemonDeath()`。
- `handleDaemonDeath()`（L757-808）：
  - 设置 `restartInProgress` 防重入；
  - 通过 `shouldAutoRestart()` 判断是否重启，依据 `MAX_RESTART_ATTEMPTS` 与 `RESTART_WINDOW_MS`（窗口内限频，uptime 超窗口则重置计数）；
  - 满足则 `void this.executeStartAttempt()` 重启 daemon 进程（连带重新 spawn serve）。
- `extension.ts` 的 `onDaemonDied`（L127-130）打印 `OpenCode daemon died; will auto-restart` 并推送状态栏。

**这一层重启的是 daemon.js，不是 serve 子进程。** 只有当 serve 挂掉导致 daemon 进程本身也崩溃（或 daemon 因别的异常死掉）时，serve 才会被重新拉起。

### 第 2 层：daemon.js 常驻进程
文件：`ai-bridge/daemon.js`

- `process.on('uncaughtException')` / `unhandledRejection`（L535-567）：捕获异常，不会让进程退出（除非 `runDaemonMain()` 顶层 `.catch` 触发，L746-757）。
- 父进程监控（L705-741）：每 3s 检查 `process.ppid`，若宿主死亡则 daemon 自行退出 → 触发宿主重启逻辑（见第 1 层）。
- **不监听 serve 子进程的 exit 事件**，也不在 serve 死亡时主动重启。serve 的生命周期完全交给 serve-manager。

### 第 3 层：serve-manager（spawn + 停止，无自动重启）
文件：`ai-bridge/services/opencode/opencode-serve-manager.js`

- `start()`（L122-133）：幂等。开头 `if (_process && _serverUrl) return _serverUrl;`——只要状态里还记着进程，就直接返回。
- `doStart()`（L135-239）：
  - 找二进制（L136 `findBinary()`）；
  - 端口已有人监听则复用（L152 `waitForReady`，冷启动兜底）；
  - 未发现监听则 `cp.spawn(binary, ['serve','--port', ...])`（L169）；
  - **`child.on('exit')`（L212-223）：只做状态清理**——若已 settle 就 `_process = null; _serverUrl = null`。**没有任何 respawn / 重连逻辑。**
  - `child.on('error')`（L202-209）：记日志 + settle 失败，同样不重启。
- `stop()`（L254-301）：发 SIGTERM，5s 内未退出则 SIGKILL / `taskkill /F /T`。优雅停止，非重启。

### 第 4 层：daemon-service（业务编排，_serveStarted 锁死）
文件：`ai-bridge/services/opencode/opencode-daemon-service.js`

- `_ensureReady(directory)`（L186-219）：**核心开关**。

  ```js
  if (!_serveStarted) {                 // L187
    await serveManager.start(DEFAULT_PORT);
    _serveStarted = true;               // L189
  }
  ```

  `_serveStarted` 一旦为 `true`，后续任何请求都**不再调用** `serveManager.start()`。
- SSE loop 死亡处理 `_runSseLoop()`（L221-263）：连接静默断开时只把 `_sseSubs` 删掉，并 `fail` 掉当前所有活跃 turn（L256-261）。注释明确写「流会在下一次请求经 `_ensureReady()` 重新建立」——但 `_ensureReady` 不会重新拉起 serve。
- 调用 `_ensureReady` 的入口：`sendMessagePersistent`（L627）、`sendShellPersistent`（L825）、`preconnectPersistent`（L931）。

---

## 三、serve 子进程挂掉后的实际行为（缺口分析）

链路推演：

1. serve 子进程崩溃 → serve-manager 的 `child.on('exit')` 触发 → `_process=null; _serverUrl=null`。**仅此而已，无重启。**
2. daemon-service 的 `_serveStarted` 仍为 `true` → 下一次 `opencode.send` 走 `_ensureReady` 时**跳过** `serveManager.start()`。
3. `sdk.setBaseUrl()` 仍指向 `http://localhost:DEFAULT_PORT`（L191，serve 已死，端口无人监听）。
4. SSE 重新订阅（或 SDK 请求）在死 server 上直接失败 → turn 报错 / 加载态卡住。
5. 宿主侧 `handleDaemonDeath` **不会**触发，因为 daemon.js 进程还活着，心跳正常。

**结果：serve 子进程死后，除非手动重启插件（让 daemon 进程整体退出并被宿主拉起），否则该工作区的 opencode 连接无法自愈。**

---

## 四、修复方向（供决策）

### 方案 A（推荐，最小且治本）：serve-manager 自愈 + daemon-service 去掉永久锁
- serve-manager 维护 `isRunning()`，并在 `child.on('exit')` 里，若非 `stop()` 触发的退出，自动 `doStart()` 重拉（带退避）。
- daemon-service 把 `if (!_serveStarted)` 改为 `if (!serveManager.isRunning())`，使 serve 死亡后能重新拉起。
- 优点：改动集中在 ai-bridge 一侧，不跨进程。

### 方案 B（轻量）：SSE 死亡时主动探活重启
- 在 `_runSseLoop` 的 `unexpectedDeath` 分支里，检测到 serve 进程已退出（`serveManager.getServeProcess() === null`）时，主动 `serveManager.start()` 再重建 SSE。
- 仅覆盖 SSE 断开这一种死法，不如方案 A 全面。

### 方案 C（治本但重）：把 serve 存活纳入宿主心跳
- daemon 心跳增加 `serveAlive` 字段，宿主据此决定是否 `restart` daemon（连带重启 serve）。
- 跨进程、改动大，仅当 A/B 不够时考虑。

> 注：三方案都需注意「serve 启动期间不要并发重复 spawn」——serve-manager 已有 `_startPromise` 去重（L126-132），复用即可。

---

## 五、关键文件索引

| 关注点 | 文件 | 行号 |
|--------|------|------|
| 宿主自动重启 daemon | `src/host/provider/OpenCodeDaemonBridge.ts` | 604-643, 757-808 |
| daemon 死亡回调 | `src/extension.ts` | 127-130 |
| daemon 常驻进程 / 父进程监控 | `ai-bridge/daemon.js` | 535-567, 705-741 |
| serve spawn / exit / stop | `ai-bridge/services/opencode/opencode-serve-manager.js` | 122-133, 169, 212-223, 254-301 |
| _serveStarted 锁 / SSE 死亡处理 | `ai-bridge/services/opencode/opencode-daemon-service.js` | 186-219, 221-263 |
| 请求入口（send/preconnect） | `ai-bridge/services/opencode/opencode-daemon-service.js` | 622-627, 825, 928-931 |
