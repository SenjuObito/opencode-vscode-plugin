# OpenCode v2 兼容性排查与分析报告

## 1. 问题背景与现象

在本地环境安装并运行 OpenCode v2（当前版本 `v2.0.27`）后，VS Code 插件（OpenCode Buddy）出现以下核心故障：
1. **无法加载历史会话列表**：打开 History 页面时持续 loading 或报错，无法拉取历史会话。
2. **发送消息立即报错**：在会话窗口发送任意消息后，状态迅速转为 error/completed，无法与 OpenCode 建立正常对话。

---

## 2. 日志信息与错误链分析

在插件日志文件（`%USERPROFILE%\.opencode-vscode-plugin\opencode-plugin.log`）中观察到以下关键错误记录：

```text
[OpenCodeDaemonBridge] Sent request 10: opencode.listSessions
[HistoryHandler] WARN  load_history_data attempt 1 Request is not supported by this version of OpenCode Server (Server responded with text/html) — retrying
[HistoryHandler] WARN  load_history_data attempt 2 Request is not supported by this version of OpenCode Server (Server responded with text/html) — retrying
[HistoryHandler] ERROR load_history_data failed: after 3 attempts: Request is not supported by this version of OpenCode Server (Server responded with text/html)
```

以及发送消息时：
```text
[OpenCodeViewProvider:right] dispatch type=send_message content={"text":"hi",...}
[OpenCodeDaemonBridge] Sent request 9: opencode.send
[OpenCodeViewProvider:right] dispatch type=tab_status_changed content={"status":"completed"}
[OpenCodeViewProvider:right] dispatch type=tab_loading_changed content={"loading":false}
```

---

## 3. 根因深度剖析

结合对插件源码、`@opencode-ai/sdk` 及 OpenCode v2（`@opencode/cli` `v2.0.27`）服务端二进制逻辑的反编译与实际探测，确认根本原因是 OpenCode v2 的**两大破坏性断代变更（Breaking Changes）**：

### 3.1 变更一：服务端 API 路由前缀调整为 `/api/*` 且嵌入 Web UI 单页应用

* **v2 服务端设计**：
  OpenCode v2 的 `opencode serve` 内置了完整的 Web 客户端页面，并将所有 REST API 和 SSE 路由收敛到 `/api/*` 前缀之下（如 `/api/session`、`/api/event` 等）。
  所有未命中 `/api/*` 的非静态文件 GET 请求均被服务端 SPA 静态中间件拦截并 rewrite 到根目录的 `index.html`（返回 `HTTP 200 text/html`）。
* **插件当前实现**：
  插件当前依赖的 `@opencode-ai/sdk`（v1.18.x）使用的是旧路径规范：
  * 列出会话请求的是：`GET /experimental/session`
  * 消息与模型等请求的是：`/session`、`/model`、`/event` 等未带 `/api` 的老路径。
* **冲突表现**：
  * 请求发往 `http://localhost:4096/experimental/session` 时，服务端返回了 HTML 页面。
  * `@opencode-ai/sdk` 客户端内置的响应拦截器（`dist/v2/client.js`）触发检查：
    ```javascript
    client.interceptors.response.use((response) => {
      const contentType = response.headers.get("content-type");
      if (contentType === "text/html")
        throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)");
      return response;
    });
    ```
  * 从而直接抛出 `Request is not supported by this version of OpenCode Server (Server responded with text/html)` 异常。

### 3.2 变更二：服务端默认强制开启 HTTP Basic Auth 认证

* **v2 服务端设计**：
  在 OpenCode v2 中，`opencode serve` 强制增加了身份验证机制（`@opencode/ServerAuthConfig`）：
  ```javascript
  let g = yield* VJ; // 读取 OPENCODE_PASSWORD 或 OPENCODE_SERVER_PASSWORD
  let b = e.mode === "service" ? f.password || z(32).toString("base64url") : g ? vH(g) : z(32).toString("base64url");
  ```
  如果运行环境中未设置环境变量 `OPENCODE_SERVER_PASSWORD` 或 `OPENCODE_PASSWORD`：
  1. 服务端会在每次启动时**自动随机生成一个 32 字节的强密码**（并在控制台打印 `server password <token>`）；
  2. 针对所有 API 端点，强制校验 `Authorization: Basic <base64(opencode:password)>` 头；
  3. 未通过认证的请求一律返回：
     ```http
     HTTP/1.1 401 Unauthorized
     WWW-Authenticate: Basic realm="Secure Area"

     {"_tag":"UnauthorizedError","message":"Authentication required"}
     ```
* **插件当前实现**：
  * `opencode-serve-manager.js` 在后台拉起进程时执行 `opencode.cmd serve --port 4096`，并未注入 `OPENCODE_SERVER_PASSWORD`；
  * `opencode-sdk-client.js` 创建客户端时未配置 Basic Auth 凭据；
  * 即使路径调整为 `/api/*`，也会直接被 401 拦截。

---

## 4. API 路由与鉴权对比表

| 功能模块 | v1 / 当前插件 SDK 预期 | OpenCode v2 实际端点 | 鉴权要求 |
| :--- | :--- | :--- | :--- |
| 获取服务信息 | `/global/health` 或 `/info` | `/api/info` | 必须 Basic Auth |
| 会话列表 | `/experimental/session` | `/api/session` | 必须 Basic Auth |
| 创建会话 | `POST /session` | `POST /api/session` | 必须 Basic Auth |
| 发送消息 | `POST /session/{id}/message` | `POST /api/session/{id}/message` | 必须 Basic Auth |
| 事件流 (SSE) | `/event` | `/api/event` | 必须 Basic Auth |
| 执行 Shell | `POST /session/{id}/shell` | `POST /api/session/{id}/shell` | 必须 Basic Auth |
| 模型列表 | `/model` | `/api/model` | 必须 Basic Auth |
| 权限回复 | `/permission/{id}/reply` | `/api/session/{id}/permission/...` | 必须 Basic Auth |

---

## 5. 修复与适配方案建议

### 方案 A：快速兼容修复（不重构依赖库）
1. **生成与共享 Daemon 通信 Secret**：
   在 `opencode-serve-manager.js` 启动 `opencode serve` 前，生成一个内部随机密钥，并作为环境变量注入：
   ```javascript
   const internalSecret = crypto.randomBytes(24).toString('base64url');
   spawnEnv.OPENCODE_SERVER_PASSWORD = internalSecret;
   ```
2. **重构 SDK Client 请求配置**：
   在 `opencode-sdk-client.js` 中：
   * 将 `baseUrl` 设置为 `http://localhost:${port}/api`；
   * 在客户端的 `headers` 中挂载 Basic Auth 头：
     ```javascript
     const basicAuthToken = Buffer.from(`opencode:${internalSecret}`).toString('base64');
     config.headers = {
       ...config.headers,
       'Authorization': `Basic ${basicAuthToken}`
     };
     ```
   * 修正 `session.list`、`session.messages` 等接口的方法映射与路径拼接。

### 方案 B：完整升级迁移
1. 升级项目依赖包至官方最新的 `@opencode/sdk` v2。
2. 对齐 v2 的完整类型定义与路由客户端生成器。
3. 规范化生命周期管理与连接状态检测。
