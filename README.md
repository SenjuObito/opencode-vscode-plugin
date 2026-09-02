# opencode-buddy

A VS Code extension that brings the **opencode** agent into a full chat GUI. The original motivation was that the existing VS Code opencode plugin was too difficult to use, and the cc-gui open source project was found on GitHub. It is a greenfield port of the
IntelliJ plugin [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui): the React webview is
carried over verbatim, the Java backend is rewritten in TypeScript, and only the **opencode** provider is kept
(Claude / Codex / Grok / Kimi / PI branches removed).

Unlike the original plugin — which spawned a fresh `opencode run` for every message — this extension keeps a
**persistent `opencode serve` daemon** (via `@opencode-ai/sdk`) alive across all tabs and conversations, managed by a
daemon bridge with prewarm, heartbeat, crash-restart, and session reuse.

## Philosophy

[`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) aims to provide a unified experience across different AI providers. This project takes a different approach — it **reuses opencode's capabilities without secondary development**, focusing on providing a native GUI experience for opencode.

## Development Tools

This project is primarily developed with AI assistance:

- **AI Tools**: OpenCode (primary), Claude Code, WorkBuddy
- **AI Models**: Deepseek-v4-flash (primary), Deepseek-v4-pro, MiMo V2.5, Ox Alpha, hy4, hy3

Most development used free tiers. Deepseek cost was 65.34 CNY.

## Support

If you find this useful, consider supporting:

| WeChat | Alipay | PayPal |
|:---:|:---:|:---:|
| ![WeChat](media/wallet.png) | ![Alipay](media/wallet-alipay.png) | ![PayPal](media/wallet-paypal.png) |

## Features

- **Persistent opencode daemon** — no per-message process spawn. `opencode serve` is prewarmed on activation,
  reused across requests, and auto-restarted on crash (≤3 attempts).
- **Two chat surfaces** — an activity-bar panel (left) and a secondary-sidebar panel (right), plus **multi-tab**
  editor sessions (each tab is an independent `createWebviewPanel` with its own conversation).
- **Full cc-gui UI** — streaming text / thinking / tool calls with diffs, model / mode / slash-command selectors,
  token-usage circle, attachments and file context, conversation history, MCP servers, agent/skill/prompt
  management, permission / question / plan-approval dialogs, and a settings panel.
- **opencode-only** — the webview, host handlers, and CLI tooling are trimmed to opencode.

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

## Acknowledgements

Thanks to the original project [`jetbrains-cc-gui`](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui). Please give it a star and consider supporting the original author.

## Sponsor

If this project helps you, consider sponsoring to support ongoing maintenance~

[View sponsors list →](SPONSORS.md)
