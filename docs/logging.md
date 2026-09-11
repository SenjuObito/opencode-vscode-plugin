# OpenCode 插件日志系统规范与排查路径

本文档记录 OpenCode IDEA 插件 与 OpenCode VS Code 插件 的独立文件日志路径及轮转机制，便于开发调试与 AI Agent 快速排查问题。

---

## 1. 日志文件路径一览

| 插件类型 | 操作系统 | 默认日志路径 | 环境变量覆盖 |
| :--- | :--- | :--- | :--- |
| **IDEA 插件** (`opencode-idea-gui`) | **macOS** | `~/Library/Logs/opencode-idea-gui/opencode-plugin.log` | `OPENCODE_PLUGIN_LOG_FILE` / `-Dopencode.log.file` |
| **IDEA 插件** (`opencode-idea-gui`) | **Linux / Windows** | `~/.opencode-idea-gui/opencode-plugin.log` | `OPENCODE_PLUGIN_LOG_FILE` / `-Dopencode.log.file` |
| **VS Code 插件** (`opencode-vscode-plugin`) | **macOS** | `~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log` | `OPENCODE_VSCODE_LOG_FILE` / `OPENCODE_PLUGIN_LOG_FILE` |
| **VS Code 插件** (`opencode-vscode-plugin`) | **Linux / Windows** | `~/.opencode-vscode-plugin/opencode-plugin.log` | `OPENCODE_VSCODE_LOG_FILE` / `OPENCODE_PLUGIN_LOG_FILE` |

> **当前本地 macOS 实际绝对路径**：
> - IDEA 插件: `/Users/obito/Library/Logs/opencode-idea-gui/opencode-plugin.log`
> - VS Code 插件: `/Users/obito/Library/Logs/opencode-vscode-plugin/opencode-plugin.log`

---

## 2. 日志规范与轮转策略

两个插件均遵循相同的文件轮转与格式规范：

1. **单文件大小限制**：最大 `8MB`。
2. **滚动备份数量**：最多保留 `3` 个备份文件（`.log.1`, `.log.2`, `.log.3`），超出后自动丢弃最旧备份。
3. **日志输出格式**：
   ```text
   MM-dd HH:mm:ss.SSS [线程名/PID] LEVEL TAG | 消息内容
   ```
4. **日志采集范围**：
   - **Webview <-> 宿主 Bridge**：包含前端发起的所有事件、后端推送的所有回调消息。
   - **OpenCode Daemon 交互**：包含 `listSessions`、`listMessages`、`deleteSession`、`updateSessionTitle`、`toggleFavorite` 等所有 SDK 命令请求与响应。
   - **状态与异常诊断**：包含 Daemon 启动/就绪状态、进程管理、报错与异常堆栈。

---

## 3. 常用排查命令

### 实时追踪日志 (tail)
```bash
# IDEA 插件
tail -f ~/Library/Logs/opencode-idea-gui/opencode-plugin.log

# VS Code 插件
tail -f ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log
```

### 过滤错误信息 (grep)
```bash
grep "ERROR" ~/Library/Logs/opencode-idea-gui/opencode-plugin.log
grep "ERROR" ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log
```
