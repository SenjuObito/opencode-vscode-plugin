# OpenCode Buddy

A VS Code extension that brings the **opencode** agent into a full chat GUI. The original motivation was that the existing VS Code opencode plugin was too difficult to use, and the cc-gui open source project was found on GitHub. It is a greenfield port of the IntelliJ plugin [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui): the React webview is carried over verbatim, the Java backend is rewritten in TypeScript, and only the **opencode** provider is kept (Claude / Codex / Grok / Kimi / PI branches removed).

Unlike the original plugin — which spawned a fresh `opencode run` process for every message — this extension keeps a **persistent `opencode serve` daemon** (via `@opencode-ai/sdk`) alive across all tabs and conversations, managed by a daemon bridge with prewarm, heartbeat, crash-restart, and session reuse.

## Philosophy

[`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) aims to provide a unified experience across different AI providers. This project takes a different approach — it **reuses opencode's capabilities without secondary development**, focusing on providing a native GUI experience for opencode.

## Development Tools

This project is primarily developed with AI assistance:

- **AI Tools**: OpenCode (primary), Claude Code, WorkBuddy, Gemini
- **AI Models**: Deepseek-v4-flash (primary), Gemini, Deepseek-v4-pro, MiMo V2.5, Ox Alpha, hy4, hy3

A Gemini Pro subscription has been purchased; Deepseek cost 89 CNY. If you find this useful, a tip would help me recover the cost.

## Features

- **Persistent opencode daemon** — no per-message process spawn. `opencode serve` (default port 4096,
  overridable via `OPENCODE_PORT`) is started or reused on demand, stays prewarmed across requests, and
  auto-restarts on crash.
- **Full chat interface** — streaming text, thinking deltas, tool-call cards with diffs; multi-tab
  sessions inside the tool window, detachable into a standalone window.
- **Native input** — `@filename` references, image attachments, one-click send of an editor selection or
  file path, opencode's native slash commands (`/init`, `/review`, …), `!shell` commands, and a
  context-compaction flow.
- **Agent / model / reasoning depth** — build / plan mode switching, any provider + model combination
  from your opencode config, and reasoning-depth (variant) selection.
- **Approval flows** — permission approval (once / always / reject), question prompts, and plan approval,
  all rendered as native panels inside the chat area.
- **Session management** — local session index with favourites and search, revert / fork / compact, and
  history export.
- **MCP** — server status view and a marketplace (install / remove MCP servers).
- **Editor integration** — a button in the editor title bar, plus two commands: open the panel in the
  left sidebar, or open it as an independent tab in an editor split.
- **Follow VS Code** — light/dark theme follows VS Code, VS Code font syncing, and a
  multi-language UI.

## Usage

### 1. Open the chat panel

After installing the extension, click the OpenCode icon in the VS Code sidebar to open the chat panel.
You can also open an independent tab in an editor split by running the *Open OpenCode Buddy in Editor
Split* command from the command palette — each tab is its own conversation.

<img src="media/home.png" width="400" alt="Chat main view">

*Screenshots show the UI in Simplified Chinese.*

UI layout:

- **Top tabs** — `Chat / Claude Code / Codex / OpenCode` to switch between conversations.
- **Top-right** — new conversation / search / history / settings.
- **Bottom bar**:
  - `Task / Subagent / Edit` — switch input mode.
  - `Build` — select the working mode (Build / Plan, etc.).
  - **Model selector** — pick the current model (e.g. `Nemotron-3.5-Lightning-Free`).
  - **Reasoning depth** — e.g. `medium`, controls how deeply the model thinks.
- **Input box** — `@filename` attaches files, `/bash ...` runs shell commands, `/opencode ...` runs
  opencode commands. `Enter` sends.

### 2. Personalise settings

Click the gear icon in the top-right of the chat panel to open the settings page:

<img src="media/settings.png" width="400" alt="Settings page">

**Basic Config → Appearance** main options:

| Item | Description |
|---|---|
| UI theme | Follow VS Code / Light / Dark |
| UI language | Follow VS Code |
| Font size / UI font / Code font | Font and sizing inside the webview |
| Diff theme | Light/dark theme for the diff view |
| Chat background / Title-bar and status-bar colour | Custom chat-area colour (custom hex supported) |

The settings page also has `Appearance / Behaviour / Environment` tabs at the top — Appearance for
visual customisation, Behaviour for agent behaviour, and Environment for runtime configuration.

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
