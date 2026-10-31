# 输入指令与引用系统技术文档 (@ / ! / /)

本文档系统性梳理 OpenCode 插件（IDEA & VS Code）在聊天输入框（ChatInputBox）中提供的三大核心交互前缀：**`@` 引用文件与子代理**、**`!` 直接执行 Bash 终端命令**、**`/` OpenCode 斜杠命令** 的完整功能逻辑、数据流转生命周期、双端实现差异及排查指南。

---

## 目录

1. [整体架构与交互总览](#1-整体架构与交互总览)
2. [@ 引用文件与子代理 (Mention & File References)](#2--引用文件与子代理-mention--file-references)
   - 2.1 触发与补全协调器
   - 2.2 数据提供器架构 (`mentionProvider`)
   - 2.3 宿主端文件获取机制 (VS Code vs IDEA)
   - 2.4 文件 Tag 渲染与发送编译
3. [! 执行 Bash 终端命令 (Direct Shell Execution)](#3--执行-bash-终端命令-direct-shell-execution)
   - 3.1 指令触发与意图识别
   - 3.2 终端工具调度与流式输出
4. [/ OpenCode 斜杠命令 (Slash Commands)](#4--opencode-斜杠命令-slash-commands)
   - 4.1 命令提供器与分组聚合
   - 4.2 本地拦截与后端分流执行
5. [数据流与调用时序图](#5-数据流与调用时序图)
6. [常见问题排查与 FAQ](#6-常见问题排查与-faq)

---

## 1. 整体架构与交互总览

输入框在占位提示（Placeholder）中明确引导了三种交互模式：
> `@引用文件，!执行 bash 命令，/opencode 命令，Enter 发送`

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ChatInputBox                                    │
│                                                                             │
│  输入 @  ───►  [mentionProvider]       ───►  子代理分组 + 文件模糊搜索列表      │
│  输入 !  ───►  [Direct Bash Mode]      ───►  直达终端工具 (bash / exec_cmd)  │
│  输入 /  ───►  [slashCommandProvider]  ───►  内置/会话/SDK 动态斜杠命令列表   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. @ 引用文件与子代理 (Mention & File References)

### 2.1 触发与补全协调器
- **组件/Hook**：`useChatInputCompletionsCoordinator.ts`
- **触发检测**：用户在输入框中输入 `@` 时，`useCompletionTriggerDetection` 计算光标相对位置并开启浮层。
- **差异化插入逻辑**：
  - **选中子代理 (`kind === 'subagent'`)**：插入纯文本 `@agentName `，光标移至末尾，不转化为 DOM FileTag。
  - **选中文件 (`kind === 'file'`)**：
    1. 文本替换为 `@/path/to/file `；
    2. 注册路径映射至 `pathMappingRef`（存储 `name -> absolutePath`，`relativePath -> absolutePath`）；
    3. 调用 `useFileTags` 将 DOM 中的 `@path` 解析并替换为带有专属图标和样式的 `<span class="file-tag" data-file-path="...">` 视觉 Chip。

---

### 2.2 数据提供器架构 (`mentionProvider`)
- **文件位置**：`mentionProvider.ts`
- **并发聚合**：
  ```typescript
  export async function mentionProvider(query: string, signal: AbortSignal): Promise<MentionItem[]> {
    const [files, subs] = await Promise.all([
      fileReferenceProvider(query, signal).catch(() => []),
      subagentMentionProvider(query, signal).catch(() => []),
    ]);
    // 渲染带有分组标题（Section Header）的统一列表：先展示子代理，后展示文件。
    // 文件通道为空时保留「文件」分组并追加一条不可选中的提示行，
    // 避免整段消失被误判为功能失效。
  }
  ```

---

### 2.3 文件候选来源（两个插件统一：opencode API）

插件定位是 opencode 的 GUI，**不自己实现文件能力**。`@` 候选只有两个服务端端点：

| 输入 | 判定 | 宿主 RPC | 服务端端点 |
|---|---|---|---|
| `@` | 无搜索文本 | `opencode.listFiles` | `GET /api/fs/list?path=` |
| `@src/` | 有目录、无搜索文本 | `opencode.listFiles`（`path=src`） | `GET /api/fs/list?path=src` |
| `@src/ho` | 有搜索文本 | `opencode.findFiles`（`query=src/ho`） | `GET /api/fs/find?query=src/ho` |

关键点：

1. **空 query 不能走 `fs.find`**：它是模糊搜索，空串没有可匹配对象，服务端返回 `{"data":[]}`（这曾导致 `@` 只有子代理、没有文件）。目录浏览必须用 `fs.list`。
2. **目录作用域**：服务端只认 `x-opencode-directory` 请求头（`directory` 查询参数会被忽略）。core 按**目标 tab 的 cwd** 设置该头，两个 tab 各自看各自的项目，不串目录。
3. **路径规范化**：`fs.list` 返回相对目录的路径，Windows 下形如 `src\host\`。宿主统一转成 POSIX 并去掉尾分隔符，再拼出 `absolutePath` 与 `extension`。
4. **事件回包**：结果作为 `files.listed` 事件投递到发起请求的 tab，载荷 `{files, requestId}`；`requestId` 用于乱序对齐。
5. **自研采集器保留但停用**：VS Code 的 `collectEntries`/`scanDirectories`/`rankEntries`、IDEA 的 `OpenFileCollector`/`RecentFileCollector`/`FileSystemCollector`/`RuntimeContextCollector` 都还在代码里，由 `LOCAL_COLLECTORS_ENABLED = false` 关闭。产品路径不调用它们；daemon/服务不可用时返回空列表并由前端提示，而不是用本地快照冒充成功。

---

### 2.4 文件 Tag 渲染与发送编译
当用户按下 Enter 发送时：
1. **DOM 解析**：`useMessageSender.ts` 从输入框提取纯文本与包含在其中的 `fileTags`（`{ displayPath, absolutePath }`）。
2. **Payload 构造**：通过 Bridge 向后端传递带有 `fileTags` 的 JSON 负载。
3. **模型上下文注入**：后端在向模型发送 prompt 时，将引用的文件路径及内容构造为上下文块，确保模型能够完整读取被 `@` 文件的准确代码。

---

## 3. ! 执行 Bash 终端命令 (Direct Shell Execution)

### 3.1 指令触发与意图识别
- **设计目标**：无需脱离聊天窗口，直接通过 `!command` 快速在项目根目录运行命令（例如 `!pwd`, `!git status`, `!npm test`）。
- **流程**：
  1. 用户在输入框以 `!` 开头输入指令（如 `!pwd what are you doing`）。
  2. 消息作为用户 Prompt 正常发送给 OpenCode 模型。
  3. OpenCode 识别到 `!` 前缀或终端执行意图，自动调用终端工具（`bash`, `execute_command`, `run_terminal_cmd` 等）。

### 3.2 终端工具调度与流式输出
- **流式接收**：Daemon 在执行过程中逐块下发 `tool_use`、`stdout` 与 `stderr` 内容。
- **前端收敛**：
  - Webview 端 `ContentBlockRenderer.tsx` 与 `BashToolGroupBlock.tsx` 自动将连续的 bash 命令聚合展示。
  - 支持输出日志实时滚动高亮、退出码（Exit Code）展示、耗时统计以及一键重新运行。

---

## 4. / OpenCode 斜杠命令 (Slash Commands)

### 4.1 命令提供器与分组聚合
- **实现位置**：`slashCommandProvider.ts`
- **命令来源聚合**：
  1. **本地系统命令 (`Local Commands`)**：
     - `/clear` / `/new` / `/reset`：清空当前会话，新建独立对话。
  2. **内置核心命令 (`Builtin Commands`)**：
     - `/compact`：触发当前会话上下文压缩总结；
     - `/undo` / `/redo`：撤销/重做最近的代码与状态变更；
     - `/fork`：分叉当前会话到新分支；
     - `/share` / `/unshare`：导出与分享会话网页；
     - `/init`：初始化 OpenCode 仓库配置；
     - `/models` / `/themes` / `/help`：快速呼出模型切换、主题切换与帮助手册。
  3. **OpenCode SDK 动态命令 (`SDK/Skill Commands`)**：
     - 从 OpenCode Serve 实时加载用户自定义的 Skills、Workflows、Prompts 与 MCP 扩展指令。

---

### 4.2 本地拦截与后端分流执行
在 `useMessageSender.ts` 中，对输入的斜杠命令进行三级分流：

```text
用户输入 "/command"
   │
   ├─► 命中本地前端指令 (/clear, /resume, /plan)
   │     └─► 直接调用前端控制器 (forceCreateNewSession, setCurrentView('history'))
   │
   ├─► 命中内置会话命令 (/compact, /undo, /redo, /fork)
   │     └─► 发送专有 Bridge RPC (compact_session, revert_message, fork_session)
   │
   └─► 命中通用/自定义斜杠命令 (/init, /custom-skill, ...)
         └─► 发送 session.command 或作为标准 command-message 交付 OpenCode 执行
```

---

## 5. 数据流与调用时序图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Input as ChatInputBox (Webview)
    participant Coord as Coordinator / Providers
    participant Host as 宿主 (VS Code / IDEA)
    participant Daemon as AI-Bridge / Daemon
    participant Server as OpenCode Serve 核心

    %% @ 引用流程
    rect rgb(240, 248, 255)
    note over User, Server: 1. @ 引用文件与子代理流程
    User->>Input: 键入 "@"
    Input->>Coord: mentionProvider.search(query)
    par 获取子代理
        Coord->>Host: 获取 Agents 列表
        Host-->>Coord: 返回 Subagent 数组
    and 获取文件列表
        Coord->>Host: files.list { query, currentPath, requestId }
        alt 无搜索文本（"@" 或 "@src/"）
            Host->>Daemon: opencode.listFiles(path)
            Daemon->>Server: GET /api/fs/list?path=  (x-opencode-directory)
        else 有搜索文本（"@src/ho"）
            Host->>Daemon: opencode.findFiles(query=src/ho)
            Daemon->>Server: GET /api/fs/find?query=src/ho  (x-opencode-directory)
        end
        Server-->>Daemon: 条目数组 [{path,type}]
        Daemon-->>Host: 结果回包
        Host-->>Coord: files.listed { files, requestId }（投递到目标 tab）
    end
    Coord-->>Input: 渲染分组下拉菜单 (子代理 + 文件)
    User->>Input: 选中目标文件
    Input->>Input: 转换为 FileTag Chip 渲染
    end

    %% / 命令流程
    rect rgb(255, 250, 240)
    note over User, Server: 2. / 斜杠命令流程
    User->>Input: 键入 "/compact" 并发送
    Input->>Host: sendBridgeEvent('compact_session')
    Host->>Daemon: session.compact()
    Daemon->>Server: 压缩上下文并刷新消息
    Server-->>Input: 推送压缩后会话快照
    end

    %% ! Bash 流程
    rect rgb(245, 255, 245)
    note over User, Server: 3. ! Bash 命令执行流程
    User->>Input: 键入 "!npm test" 并发送
    Input->>Host: send_message("!npm test")
    Host->>Server: 发送用户 Prompt
    Server->>Server: 识别 ! 前缀 -> 调度 bash 工具
    Server-->>Input: 流式推送 tool_use: bash / stdout 输出
    end
```

---

## 6. 常见问题排查与 FAQ

### Q1: 输入 `@` 只有子代理、没有文件列表？
- **根因**：`@` 时搜索文本为空，旧实现把它送进 `opencode.findFiles`（`GET /api/fs/find?query=`）。该端点是**模糊搜索**，空串没有可匹配对象，服务端返回 `{"data":[]}`；而本地采集器只在**请求抛异常**时才兜底，正常返回空数组不会触发，于是「文件」分组整体消失，只剩子代理。
- **修复**：空搜索文本改走 `GET /api/fs/list?path=`（VS Code `opencode.listFiles`，IDEA 同名桥接），`@src/` 用 `path=src`；只有真正输入了文本才用 `fs.find`，并把目录前缀拼进 query（`src/ho`）。两个插件都不再在失败时用本地快照冒充成功。
- **自查**：
  1. 控制台应看到 `files.list tab=… query="" path="" cwd=… n=N`（VS Code `[TabFileCommandHandler]` / IDEA `[TabFileCommandHandler]`）。
  2. `n=0` 时确认 daemon 存活、`cwd` 是目标 tab 的项目目录；前端会显示「未找到匹配的文件」而不是静默无分组。
  3. 需要确认服务端行为时直接请求：`/api/fs/list?path=` 正常、`/api/fs/find?query=` 为空属预期。
  4. 若日志出现 `Unknown command: opencode.listFiles`，说明打包用的 core 版本过旧（老 core 不认识该命令），需要用同级 `../opencode-buddy-core` 或新版本 core。

### Q2: 选中的文件在输入框内显示为纯文本而非蓝色 Chip？
- **排查点**：
  1. 确认选中的是文件还是子代理：子代理故意保留为纯文本 `@agentName`，仅文件会转化为带有 `data-file-path` 的 `file-tag`。
  2. 检查 `useFileTags.ts` 中的正则匹配规则是否覆盖了操作系统的文件路径分隔符（Windows `\` 与 POSIX `/`）。

### Q3: 斜杠命令下拉框提示“正在加载中”或超时？
- **排查点**：
  1. 检查宿主是否在页面初始化时正确触发了 `window.updateSlashCommands(...)`。
  2. 检查是否有网络阻塞导致从 OpenCode Serve 拉取 Slash Commands 超时。
