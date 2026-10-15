# OpenCode v2 全量协议适配与迁移指南

> **适用范围**：本文档沉淀了从 OpenCode v1 升级至 OpenCode v2 过程中的全部底层架构变化、REST API 规范、SSE 实时流协议、数据模型转换以及前后端组件适配逻辑。旨在为后续 **`opencode-vscode-plugin`** 及其他宿主客户端提供完整、精确、即插即用的 v2 适配参考。

---

## 目录

1. [背景与架构重大变更](#1-背景与架构重大变更)
2. [认证、服务发现与生命周期](#2-认证服务发现与生命周期)
3. [会话管理与历史加载 (Sessions & Messages)](#3-会话管理与历史加载-sessions--messages)
4. [提问、附件与命令执行 (Prompt, Attachments & Commands)](#4-提问附件与命令执行-prompt-attachments--commands)
5. [SSE 实时事件流与工具生命周期 (SSE & Tool Protocol)](#5-sse-实时事件流与工具生命周期-sse--tool-protocol)
6. [Token 用量统计与模型上下文容量 (Tokens & Capacity)](#6-token-用量统计与模型上下文容量-tokens--capacity)
7. [问题工具与权限审批 (Form System & Permissions)](#7-问题工具与权限审批-form-system--permissions)
8. [状态面板同步 (Tasks, Subagents, Edits)](#8-状态面板同步-tasks-subagents-edits)
9. [VS Code 插件适配实战 Checklist](#9-vs-code-插件适配实战-checklist)

---

## 1. 背景与架构重大变更

| 维度 | OpenCode v1 架构 | OpenCode v2 架构 |
| :--- | :--- | :--- |
| **通信机制** | 基于 `@opencode-ai/sdk` 的 RPC 客户端封装 / stdio | 基于标准的 HTTP RESTful API (OpenAPI 3.1) + Server-Sent Events (SSE) |
| **API 校验** | 宽松入参，支持额外属性 | 极严格 JSON Schema (`additionalProperties: false`)，非法字段直接 400 拦截 |
| **消息结构** | 包含 `role: "assistant" \| "user"` 字段 | 仅包含 `type: "assistant" \| "user"`，不再提供 `role` 字段 |
| **提问机制** | `question.asked` / `questionV2.asked`，数组结构 | 升级为 **Form 体系**（表单 Schema，按 `field.key` 组织问答） |
| **附件传递** | 允许在 `prompt` 中传递 `parts` 数组 | **彻底废弃 `parts`**，改用 `files: [{ uri, name }]` 字段 |
| **工具事件** | 单一事件包含工具名与参数快照 | 事件流拆解为 `tool.input.started` (含名) -> `tool.called` (仅含入参) |

---

## 2. 认证、服务发现与生命周期

### 2.1 服务发现与端口
- 默认监听端口：`4096`（可由环境变量或参数指定）。
- 服务凭证位置：`~/.config/opencode/service.json`。
  ```json
  {
    "password": "UEFHT8eUArdnCz-tPJH6vVstF8di9_zTddOAyki7tZs"
  }
  ```

### 2.2 请求头规范 (Headers)
客户端调用任何 REST 接口与 SSE 流时，必须携带 Basic 认证头与工作目录头：
```javascript
function getAuthHeader() {
  const pwd = serveManager.getServerPassword(); // 从 service.json 读取
  if (!pwd) return {};
  const encoded = Buffer.from(`opencode:${pwd}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

// 跨项目空间作用域请求头（重要：保证命令在项目根目录运行）
headers['x-opencode-directory'] = encodeURIComponent(projectDirectory);
```

### 2.3 版本探活判断
调用 `GET /api/info`：若返回 HTTP 200 则为 v2 架构；若 404 或无响应则退回 v1。
```javascript
export async function isV2Server(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/info`, { headers: getAuthHeader() });
    return res.status === 200;
  } catch {
    return false;
  }
}
```

---

## 3. 会话管理与历史加载 (Sessions & Messages)

### 3.1 创建会话 (`POST /api/session`)
- **v1**: `{ title, directory }`
- **v2**:
  ```json
  {
    "title": "新建会话",
    "location": {
      "directory": "D:\\source\\repos\\my-project"
    }
  }
  ```

### 3.2 会话列表筛选 (`GET /api/session`)
- 返回结果结构：`{ data: [ ... ], location: { directory: "..." } }`。
- **项目路径对比兼容**：Windows 下路径大小写可能不一致，斜杠存在反斜杠/正斜杠差异。对比过滤当前项目会话时必须做归一化：
  ```javascript
  function normalizeDirForMatch(p) {
    if (!p || typeof p !== 'string') return '';
    let normalized = p.replace(/\\/g, '/');
    if (process.platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
  }
  ```

### 3.3 消息列表加载 (`GET /api/session/:id/message`)
这是历史会话加载中**最核心的踩坑点**：

1. **时间排序倒序问题**：
   OpenCode v2 服务端默认返回**倒序（最新消息在前）**。若直接渲染，用户 Prompt 会显示在模型回复下方。必须按时间戳显式升序排序：
   ```javascript
   const sortedList = [...list].sort((a, b) => {
     const ta = (a?.time && (a.time.created || a.time.start)) || 0;
     const tb = (b?.time && (b.time.created || b.time.start)) || 0;
     return ta - tb;
   });
   ```

2. **角色字段转换**：
   v2 消息对象字段为 `m.type`（如 `"user"`, `"assistant"`, `"idle"`, `"compaction"`）。前端和桥接层需映射为标准 `role`：
   ```javascript
   const role = m.type === 'user' ? 'user' : (m.type === 'assistant' ? 'assistant' : m.type);
   ```

3. **消息内容解析**：
   - Assistant 消息在 `m.content` 数组中，可能包含：
     - `{ type: "text", text: "..." }`
     - `{ type: "reasoning", text: "..." }`
     - `{ type: "tool", id: "...", name: "...", state: { status, input, output, error } }`
   - User 消息文本可能在 `m.text`、`m.payload.text` 或 `m.content` 中，需多级兜底提取。

---

## 4. 提问、附件与命令执行 (Prompt, Attachments & Commands)

### 4.1 发送提问 (`POST /api/session/:id/prompt`)
> ⚠️ **高危坑点**：v2 的 `prompt` 接口配置了 `additionalProperties: false`。
> **切勿在请求体传递 `body.parts`！** 一旦传入，服务端直接拒绝或静默忽略！

#### 规范请求体结构：
```json
{
  "text": "用户提问文本",
  "files": [
    {
      "uri": "data:image/png;base64,iVBORw0KGgo...",
      "name": "screenshot.png"
    },
    {
      "uri": "file:///d:/source/repos/my-project/README.md",
      "name": "README.md"
    }
  ]
}
```

#### 附件类型转换规则：
- **图片附件**：转为 Data URL (`data:image/...;base64,...`)，放入 `files` 数组的 `uri` 字段。
- **@ 引用文件**：转为 `file:///` 绝对路径 URI，放入 `files` 数组的 `uri` 字段。
- **OpenCode 原生解析**：v2 接收到 `files` 后，会自动在服务端按多模态读取图片，或按文件协议读取本地文件上下文。

### 4.2 执行斜杠命令 (`POST /api/session/:id/command`)
- **v1**: `{ command: "opencode", arguments: "..." }`
- **v2**:
  ```json
  {
    "name": "opencode",
    "text": "参数内容"
  }
  ```

---

## 5. SSE 实时事件流与工具生命周期 (SSE & Tool Protocol)

SSE 监听地址：`GET /api/event`。

### 5.1 核心流式事件流转
1. **思考过程 (Reasoning)**：
   - 开始：`session.reasoning.started`
   - 增量：`session.reasoning.delta` -> payload: `data.delta`（发出 `[THINKING_DELTA]`）
   - 结束：`session.reasoning.ended`
2. **正文输出 (Text)**：
   - 开始：`session.text.started`
   - 增量：`session.text.delta` -> payload: `data.delta`（发出 `[CONTENT_DELTA]`）
   - 结束：`session.text.ended`
3. **单步结束 (Step End)**：
   - 事件：`session.step.ended` -> payload: `data.tokens`, `data.cost`, `data.finish`
4. **会话完成 (Succeeded / Failed)**：
   - 成功：`session.execution.succeeded`（通知前端结算当前 turn）
   - 失败：`session.execution.failed`

### 5.2 工具调用（Tool Call）三步拆解机制
在 v2 中，工具调用事件被拆分到了不同事件中：
```mermaid
sequenceDiagram
    participant S as OpenCode v2 SSE
    participant D as Daemon (Bridge)
    participant UI as Webview / Host
    
    S->>D: session.tool.input.started (携带 tool ID 与 tool Name)
    Note over D: 缓存 turn.toolNames.set(id, name)
    S->>D: session.tool.called (携带 tool ID 与 input 参数，无 name!)
    Note over D: 从缓存取回 name; 将 shell 映射为 bash
    D->>UI: [MESSAGE] tool_use (id, name, input)
    S->>D: session.tool.success (携带 tool ID 与 content 数组)
    Note over D: 从 content 文本块数组提取输出
    D->>UI: [MESSAGE] tool_result (id, content, isError)
```

#### 代码实现要点：
```javascript
case 'session.tool.input.started': {
  const callID = props.toolID || props.id;
  const name = props.name || props.tool;
  if (callID && name) {
    turn.toolNames.set(callID, name);
  }
  break;
}

case 'session.tool.called': {
  const callID = props.toolID || props.id;
  let name = props.name || props.tool || turn.toolNames.get(callID) || 'tool';
  if (name === 'shell') name = 'bash'; // 统一 Bash 工具名
  turn.toolNames.set(callID, name);
  emitToolUseMessage({ id: callID, name, input: props.input || {} });
  break;
}

case 'session.tool.success': {
  const callID = props.toolID || props.id;
  let content = '';
  if (Array.isArray(props.content)) {
    content = props.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
  } else {
    content = props.output ?? props.result ?? '';
  }
  emitToolResultMessage({ toolUseId: callID, content, isError: false });
  break;
}
```

---

## 6. Token 用量统计与模型上下文容量 (Tokens & Capacity)

### 6.1 Token 统计提取
- **实时用量**：监听 `session.usage.updated` 和 `session.step.ended`。
  ```javascript
  const tokens = props.tokens; // { input, output, reasoning, cache: { read, write } }
  ```
- **回合聚合**：由于 v2 消息无 `role` 字段，聚合助理消息用量时必须匹配：
  ```javascript
  const isAssistant = props.info.role === 'assistant' || props.info.type === 'assistant';
  ```

### 6.2 模型上下文容量匹配
1. 调用 `GET /api/model` 获取全量模型配置。
2. 每个模型对象包含 `limit: { context: 262144, output: 131072 }`。
3. 查找模型容量时，由于模型 ID 可能是 `anthropic/claude-3-7-sonnet` 或去前缀的 `claude-3-7-sonnet`，必须多层匹配：
   ```javascript
   const bareModel = typeof foundModelId === 'string' ? foundModelId.split('/').pop() : '';
   const mInfo = p?.models?.[foundModelId]
     || (bareModel ? p?.models?.[bareModel] : null)
     || Object.values(p?.models || {}).find(m => m?.id === foundModelId || m?.id === bareModel || m?.name === foundModelId || m?.name === bareModel);
   const maxTokens = mInfo?.limit?.context || 200000;
   ```

---

## 7. 问题工具与权限审批 (Form System & Permissions)

### 7.1 权限审批 (Permission Request)
- **触发事件**：`permission.asked` / `permission.requested`。
  - Payload 包含：`{ id, sessionID, action, resources }`。
- **响应接口**：`POST /api/session/:id/permission/:requestID/reply`。
  - ⚠️ **入参必须使用 `decision` 字段，而非 `reply`！**
  ```json
  {
    "decision": "once",  // 可选值: "once" | "always" | "reject"
    "message": null
  }
  ```

### 7.2 提问表单体系 (Form System)
- **触发事件**：`form.created` / `form.asked`。
  - Payload 结构：
    ```json
    {
      "id": "form_123",
      "sessionID": "ses_456",
      "title": "选择架构方案",
      "fields": [
        {
          "key": "framework",
          "title": "目标框架",
          "type": "multiselect",
          "options": [
            { "label": "React", "value": "react" },
            { "label": "Vue", "value": "vue" }
          ]
        }
      ]
    }
    ```
- **标准化适配**：在 `event-normalize.js` 中将 `fields` 转换为 UI Dialog 的 questions 列表。
- **提交答案接口**：`POST /api/session/:id/form/:formID/reply`。
  - Payload:
    ```json
    {
      "answer": {
        "framework": ["react"]
      }
    }
    ```
- **拒绝/关闭接口**：`DELETE /api/session/:id/form/:formID`。
- **生命周期关闭事件**：监听 `form.replied` / `form.discarded` / `form.deleted`，收到时销毁前端弹窗卡片，避免悬挂。

---

## 8. 状态面板同步 (Tasks, Subagents, Edits)

前端状态面板依赖从 `messages` 消息流中提取工具调用卡片：
1. **Edits (代码编辑与 Diff)**：
   - 提取自 `tool_use` 名称属于 `FILE_MODIFY_TOOL_NAMES` (`edit`, `write`, `patch`, `apply_patch`)。
   - 确保 `edit`/`write` 工具调用时入参中的 `path` 字段完整保留（在 `_handleToolPart` 中监听非空参数时立即发送）。
2. **Subagents (子代理)**：
   - 提取自 `tool_use` 名称属于 `AGENT_TOOL_NAMES` (`task`, `agent`, `spawn_agent`)。
3. **Tasks (任务待办清单)**：
   - 提取自 `todo.updated` 事件或 `TaskCreate` / `TaskUpdate` 工具调用。
4. **终端执行 (Bash / Terminal)**：
   - Webview 的 `BASH_TOOL_NAMES` 中添加 `'shell'`：
     ```typescript
     export const BASH_TOOL_NAMES = new Set(['bash', 'shell', 'run_terminal_cmd', ...]);
     ```

---

## 9. VS Code 插件适配实战 Checklist

后续在 `opencode-vscode-plugin` 中落地 v2 适配时，请依序检查并修改以下文件：

- [ ] **1. `ai-bridge/services/opencode/event-normalize.js`**
  - [ ] `normalizePermissionRequest`: 支持 `props.action`、`props.requestID` 兜底。
  - [ ] `normalizeQuestionRequest`: 支持解析 `Form.Info` (`props.fields` 或 `props.data.fields`)。
- [ ] **2. `ai-bridge/services/opencode/opencode-sdk-client.js`**
  - [ ] `promptAsync`: 去除 `body.parts`，转换 `options.parts` / `options.files` 为 `body.files = [{ uri, name }]`。
  - [ ] `replyPermission`: v2 模式请求体改为 `{ decision, message }`。
  - [ ] `replyQuestion`: v2 模式调用 `/api/session/:id/form/:formID/reply`，发送 `{ answer: { [key]: value } }`。
  - [ ] `rejectQuestion`: v2 模式调用 `DELETE /api/session/:id/form/:formID`。
  - [ ] `listMessages`: 结果按 `time.created || time.start` 升序排序，映射 `type: "assistant"` 到 `role: "assistant"`。
- [ ] **3. `ai-bridge/services/opencode/opencode-daemon-service.js`**
  - [ ] `_createTurn`: 初始化 `toolNames: new Map()`。
  - [ ] `message.updated`: 识别 `info.role === 'assistant' || info.type === 'assistant'`。
  - [ ] 事件分发监听：
    - `session.tool.input.started`: 记录 `callID -> name`。
    - `session.tool.called`: 回填 `name`，映射 `shell` -> `bash`。
    - `session.tool.success`: 从 `props.content`（文本数组）提取结果。
    - `form.created` / `form.asked`: 发出 `[QUESTION_REQUEST]`。
    - `form.replied` / `form.discarded`: 发出 `[QUESTION_CLOSED]`。
  - [ ] `getContextUsagePersistent`: 支持 `type === 'assistant'` 并完善 Provider 模型上下文容量查找。
- [ ] **4. Webview 端 (`webview/src/utils/toolConstants.ts`)**
  - [ ] `BASH_TOOL_NAMES`: 加入 `'shell'`。
- [ ] **5. 回归验证套件**
  - [ ] 运行 `ai-bridge` 单元测试：`npm test`。
  - [ ] 运行 Webview 单元测试：`pnpm test`。
  - [ ] 启动 VS Code 扩展端到端验证：Token 计数、表单弹窗、权限批准、图片识别、`@` 引用文件、状态面板动态更新。
