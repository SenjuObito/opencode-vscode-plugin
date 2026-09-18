# OpenCode 插件与服务日志路径及排查指南

本文档汇总了 **OpenCode VS Code 插件** 与 **OpenCode 后端服务** 在不同操作系统下的日志落盘路径、全链路日志流向以及排查命令。

---

## 1. 插件端文件日志路径 (Plugin File Logs)

插件内置 `PluginFileLogger`，所有来自 **Webview 前端**、**VS Code 宿主** 以及 **Node AI-Bridge (含 opencode serve 生命周期)** 的日志均统一同步持久化到以下本地磁盘文件中（单文件上限 8MB，支持 3 代自动轮转备份）：

- **macOS**:
  `~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log`
- **Linux / UOS (如 UOS 20 / Debian 10)**:
  `~/.opencode-vscode-plugin/opencode-plugin.log`
- **Windows**:
  `%USERPROFILE%\.opencode-vscode-plugin\opencode-plugin.log`

*(可通过环境变量 `OPENCODE_VSCODE_LOG_FILE` 或 `OPENCODE_PLUGIN_LOG_FILE` 自定义指定)*

---

## 2. 后端服务端底层引擎日志 (OpenCode Core Server Logs)

- **OpenCode Serve 核心服务日志**:
  `~/.local/share/opencode/log/opencode.log`

---

## 3. 全链路日志架构与各层输出规范

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Webview (React)                                          │
│    - 调试日志必须使用 cardDebugLog('[Tag]', data)           │
│    - 字体探查日志: [FontDiagnostic:sync]                     │
│    - 生产模式静默 console.log，cardDebugLog 经 bridge 转发宿主│
└──────────────────────────────┬──────────────────────────────┘
                               │ sendBridgeEvent('cardDebug')
┌──────────────────────────────▼──────────────────────────────┐
│ 2. VS Code 插件宿主 (src/host)                              │
│    - 使用 logDiagnostic(message, tag) / logError(...)       │
│    - 统一写入 PluginFileLogger (opencode-plugin.log)         │
│    - 同时向 VS Code 输出通道「OpenCode」追加实时诊断          │
└──────────────────────────────▲──────────────────────────────┘
                               │ stdio NDJSON & Stderr 拦截
┌──────────────────────────────┴──────────────────────────────┐
│ 3. AI Bridge 守护进程 (ai-bridge/)                          │
│    - 使用 ai-bridge/utils/logger.js (logInfo, logError 等)   │
│    - 运行时环境诊断: [opencode-serve-manager:env]            │
│    - 进程崩溃与在途熔断: [OpenCodeDaemon:watchdog]           │
│    - 所有 stderr 经由宿主 startStderrReader 100% 写入文件日志 │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 关键排查日志标签 (Log Tags)

在日志文件 `opencode-plugin.log` 中搜索以下标签可快速定位问题：

| 标签 | 来源 | 作用说明 |
| :--- | :--- | :--- |
| `[FontDiagnostic:sync]` | Webview | 打印前端字体配置、计算 CSS 变量以及 `Noto Sans CJK` / 系统 Fallback 字体命中状态 |
| `[FontConfigHandler]` | 宿主 | 打印宿主下发给 Webview 的编辑器与 UI 字体配置 |
| `[opencode-serve-manager:env]` | AI-Bridge | 打印 Daemon Node 版本、`execPath`、系统 PATH Node 版本、CLI 路径与版本 |
| `[opencode-serve-manager:spawn]` | AI-Bridge | 打印 `opencode serve` 启动参数、子进程 PID 与端口 |
| `[opencode-serve-manager:exit]` | AI-Bridge | 打印 `opencode serve` 进程异常退出的退出码、信号、运行时间与 stderr tail |
| `[OpenCodeDaemon:watchdog]` | AI-Bridge | 记录在途 Turn 因服务崩溃或 45s 空闲超时被主动熔断的事件 |
| `[heartbeat:warn]` | 宿主 | 记录有活跃请求但在心跳中检测到 `serveRunning === false` 的警告 |

---

## 5. 常用排查命令

```bash
# 实时查看 VS Code 插件全链路日志 (macOS)
tail -f ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log

# 实时查看 VS Code 插件全链路日志 (Linux / UOS)
tail -f ~/.opencode-vscode-plugin/opencode-plugin.log

# 过滤字体与环境诊断日志
tail -f ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log | grep -E "FontDiagnostic|opencode-serve-manager"

# 实时查看 OpenCode 服务端日志
tail -f ~/.local/share/opencode/log/opencode.log
```