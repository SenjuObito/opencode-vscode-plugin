# OpenCode Buddy

A VS Code extension that brings the **opencode** agent into a full chat GUI. The original motivation was that the existing VS Code opencode plugin was too difficult to use, and the cc-gui open source project was found on GitHub. It is a greenfield port of the IntelliJ plugin [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui): the React webview is carried over verbatim, the Java backend is rewritten in TypeScript, and only the **opencode** provider is kept (Claude / Codex / Grok / Kimi / PI branches removed).

Unlike the original plugin — which spawned a fresh `opencode run` process for every message — this extension keeps a **persistent `opencode serve` daemon** (via `@opencode-ai/sdk`) alive across all tabs and conversations, managed by a daemon bridge with prewarm, heartbeat, crash-restart, and session reuse.

## Philosophy

[`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) aims to provide a unified experience across different AI providers. This project takes a different approach — it **reuses opencode's capabilities without secondary development**, focusing on providing a native GUI experience for opencode.

## Development Tools

This project is primarily developed with AI assistance:

- **AI Tools**: OpenCode (primary), Claude Code, WorkBuddy, Gemini
- **AI Models**: Deepseek-v4-flash (primary), Gemini, Deepseek-v4-pro, MiMo V2.5, Ox Alpha, hy4, hy3

A Gemini Pro subscription has been purchased; Deepseek cost 120 CNY. If you find this useful, a tip would help me recover the cost.

## Features

- **Persistent OpenCode Daemon** — No per-message process spawn. Runs a persistent `opencode serve` daemon (default port 4096, configurable via `OPENCODE_PORT`) via `@opencode-ai/sdk`, prewarmed across requests, with automatic heartbeat keep-alive, crash recovery, and context isolation using `AsyncLocalStorage`.
- **Full Streaming Chat Interface** — Real-time streaming text responses, interactive thinking deltas, structured tool-call cards with expandable diff views.
- **Multi-Panel & Flexible Layouts** — Native integration with VS Code Activity Bar (left), Secondary Sidebar (right), and Editor Split views; one-click launch from the editor title bar.
- **Multi-Tab Session Management** — Seamless multi-tab conversation switching and management within the same panel window.
- **Rich Context & Native Inputs**:
  - `@` symbol file and symbol reference autocomplete.
  - Image attachments via drag-and-drop or clipboard paste.
  - One-click context insertion from editor selection and file paths.
  - OpenCode native slash commands (`/init`, `/review`, etc.) and `!shell` command executions.
  - Context compaction support to optimize token usage.
- **Agent Modes, Models & Reasoning Depth** — Switch between Build and Plan modes, dynamically retrieve and select configured providers/models from OpenCode, and configure reasoning depth / variants (e.g. `low`, `medium`, `high`).
- **Permission Approvals & Interactive Prompts** — Granular permission approval system (allow once, always allow, reject), interactive questions (`AskUserQuestion` dialog), and plan confirmation approvals directly in chat.
- **File Changes & One-Click Undo** — Live tracking of AI-generated file edits with diffs; revert changes per-file or roll back all changes in batch.
- **Session History & Time Travel (Rewind / Fork)** — Local session index with search, favourites, renaming, and deletion; rewind to any previous message turn to fork or regenerate; export conversations to Markdown.
- **MCP Servers & Marketplace** — Monitor MCP server status, browse, install, configure, and remove MCP servers through a built-in marketplace.
- **Skills System Management** — Global and workspace-level skill auto-discovery, one-click import, enable/disable toggling, and direct opening of `SKILL.md` files in VS Code.
- **Token & Usage Tracking** — Live tracking and visualization of token consumption per message and tool call.
- **Theming & Deep Personalization** — Fully synchronized with VS Code light/dark themes, custom font sizes and families (UI & monospace code fonts), customizable chat backgrounds and bar colors, diff theme options, and multi-language UI.

## Usage

### 1. Open the Chat Panel

After installing the extension, you can open OpenCode Buddy in several ways:
- Click the **OpenCode icon** in the VS Code Activity Bar (left).
- Click the **OpenCode icon** in the editor title bar.
- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
  - `Open OpenCode Buddy Panel (Left)`
  - `New OpenCode Buddy Chat` (opens a standalone tab in an editor split for parallel sessions)

<img src="media/home.png" width="600" alt="Chat main view">

*Screenshots show the UI in Simplified Chinese.*

UI layout:

- **Top Tabs** — Switch between, open, and close independent conversation sessions.
- **Top-Right Actions** — New session, search, history drawer, and settings.
- **Bottom Bar**:
  - `Task / Subagent / Edit` — Switch input mode.
  - `Build / Plan` — Switch working mode.
  - **Model Selector** — Select active model (e.g. `deepseek-v3`, `claude-3-7-sonnet`).
  - **Reasoning Depth (Variant)** — Control reasoning effort (e.g. `low`, `medium`, `high`).
- **Input Box** — `@filename` references, drag-and-drop images, `/bash ...` commands, `/opencode ...` commands. Press `Enter` to send (`Shift+Enter` for new line).

### 2. Personalise Settings

Click the gear icon in the top-right of the chat panel to open the settings page:

<img src="media/settings.png" width="350" alt="Settings page">

**Basic Config → Appearance** main options:

| Item | Description |
|---|---|
| UI theme | Follow VS Code / Light / Dark |
| UI language | Follow VS Code / Simplified Chinese / English |
| Font size / UI font / Code font | Font families and sizing inside the webview |
| Diff theme | Light/dark theme for the diff view |
| Chat background / Title-bar and status-bar colour | Custom chat-area colour scheme (custom hex supported) |

The settings page also includes tabs for `Appearance`, `Behaviour`, `Environment`, `MCP`, and `Skills` to configure agent parameters, MCP integrations, and skill packages.

## Requirements

- **opencode CLI** installed and on `PATH` (Settings → Providers → CLI shows its install status; the plugin never
  auto-installs binaries).
- A working Node.js runtime — the extension host spawns the daemon via `process.execPath` (Electron-as-node).

## Development

Package manager is **pnpm**. The repo has three parts, each with its own dependencies:

| Part | Role | Install | Build |
|---|---|---|---|
| `src/` | Extension host (TS rewrite of the Java backend) | `pnpm install` (repo root) | `pnpm run compile` |
| `webview/` | React 19 + Vite + Tailwind + antd UI (cc-gui copy) | `cd webview && pnpm install` | `cd webview && pnpm run build` |
| `ai-bridge/` | Persistent daemon: `opencode serve` + `@opencode-ai/sdk` | `cd ai-bridge && pnpm install` | ESM run directly, no bundle |

The webview build emits a single-file bundle to `dist/webview/index.html`; the extension host bundle is
`dist/extension.js` (CJS). Press **F5** in VS Code to launch the Extension Development Host.

### Commands (extension host)

| Task | Command |
|---|---|
| Type-check | `pnpm run check-types` (`tsc --noEmit`) |
| Lint | `pnpm run lint` (`eslint src`) |
| Build (dev) | `pnpm run compile` (check-types → lint → esbuild) |
| Build (production) | `pnpm run package` (minified) |
| Watch (dev) | `pnpm run watch` |
| Run tests | `pnpm test` (vscode-test against a real VS Code instance) |

### Commands (webview)

| Task | Command |
|---|---|
| Build | `cd webview && pnpm run build` (tsc → vite build, emits single-file bundle) |
| Unit tests | `cd webview && pnpm test` (vitest) |
| E2E tests | `cd webview && pnpm test:e2e` (Playwright) |

## Architecture

```
webview/ (React SPA)  ⇄  src/ extension host (TS)  ⇄  ai-bridge/daemon.js (Node ESM)
                            │                              └─ @opencode-ai/sdk ─ opencode serve (persistent)
                            ├─ src/host/router/*        — "type:content" wire protocol
                            ├─ src/host/handlers/*      — one handler per message type (incl. permission)
                            ├─ src/host/session/*       — OpenCodeSession, marker parser/merger
                            ├─ src/host/provider/*      — OpenCodeDaemonBridge (NDJSON + heartbeat)
                            ├─ src/host/tabs/*          — multi-tab panels (TabManager)
                            ├─ src/host/settings/*      — SettingsService + TabStateService (workspaceState)
                            ├─ src/host/services/*      — McpConfigService, SkillService, etc.
                            ├─ src/host/context/*       — EditorContextTracker
                            ├─ src/host/notifications/* — NotificationService
                            └─ src/host/fonts/*         — SystemFontEnumerator
```

- The webview talks to the host with `sendToJava("type:content")`; the host replies via
  `postMessage({ type: fn, args })` calling `window[fn](...args)`. All webview panels (left sidebar, right
  sidebar, editor split) share the same `BroadcastChannel`.
- `ai-bridge/daemon.js` speaks NDJSON over stdio: `{id, method, params}` requests, `{id, line}` streaming output,
  `{type:'daemon', event}` lifecycle events. The host request is non-blocking. Concurrent requests use
  `AsyncLocalStorage` for context isolation.
- The extension host (`src/host/`) mirrors cc-gui's Java module layout: `router/`, `handlers/`, `session/`,
  `provider/`, `settings/`, `tabs/`, `util/`, `services/`, `context/`, `notifications/`, `fonts/`.

## Support

If you find this useful, consider supporting:

| WeChat | Alipay | PayPal |
|:---:|:---:|:---:|
| <img src="webview/src/assets/images/wallet.png" width="200" alt="WeChat"> | <img src="webview/src/assets/images/wallet-alipay.png" width="200" alt="Alipay"> | <img src="webview/src/assets/images/wallet-paypal.png" width="200" alt="PayPal"> |

## Acknowledgements

Thanks to the original project [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui). Please give it a star and consider supporting the original author.

## Sponsor

If this project helps you, consider sponsoring to support ongoing maintenance~

[View sponsors list →](SPONSORS.md)
