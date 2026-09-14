# OpenCode 插件与服务日志路径汇总

## 1. 插件端文件日志路径 (macOS)

- **IDEA 插件 (`opencode-idea-gui`)**:
  `/Users/obito/Library/Logs/opencode-idea-gui/opencode-plugin.log`

- **VS Code 插件 (`opencode-vscode-plugin`)**:
  `/Users/obito/Library/Logs/opencode-vscode-plugin/opencode-plugin.log`

## 2. 后端服务端日志路径

- **OpenCode Serve 核心服务日志**:
  `/Users/obito/.local/share/opencode/log/opencode.log`

## 3. 常用排查命令

```bash
# 实时查看 IDEA 插件日志
tail -f ~/Library/Logs/opencode-idea-gui/opencode-plugin.log

# 实时查看 VS Code 插件日志
tail -f ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log

# 实时查看 OpenCode 服务端日志
tail -f ~/.local/share/opencode/log/opencode.log
```