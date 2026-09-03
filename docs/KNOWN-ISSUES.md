# 已知问题 / 待后续版本处理清单

> 维护说明：本文件汇总**本次版本暂不处理**、计划后续版本再清理或修复的项。
> 相关上下文见 `.workbuddy/memory/`。

## 已临时处理（本版本）
- **历史列表「下载会话」按钮已临时隐藏**：点击无响应（`handleExport` → `onExport` 未产生可见效果）。
  实现方式：在 `webview/src/components/history/HistoryListItem.tsx` 用 `const showExportButton = false;` 包裹按钮 JSX，
  **handler、`onExport` prop、i18n `history.exportSession` 等均保留**，未做删除。后续若修复导出功能，把该常量改回 `true` 即可。

## 本版本已修复（功能缺陷）
- **未回答的 askUserQuestion 提问卡片却显示「已回答」**：
  - 根因：`ContentBlockRenderer.tsx` 对**每一个** `askuserquestion` 工具块都无条件渲染 `QuestionAnswerSummary`，
    而该组件把「已回答」徽章（✓）写死；只要 `storedQA` 或任意 `tool_result` 存在（跳过的提问也会留下空的 tool_result），就显示「已回答」。
  - 修复：`QuestionAnswerSummary` 新增 `answered?: boolean` prop（默认 `true` 兼容既有用法）；未回答时改用 `codicon-question` 图标 + 「未回答」灰徽章（新增 i18n `askUserQuestion.unansweredStatus`，10 语种）。
    `ContentBlockRenderer` 仅在答案文本非空时才传 `answered={true}`，否则传 `false`。
  - 影响文件：`ContentBlockRenderer.tsx`、`QuestionAnswerSummary.tsx`、`.css`、10 个 i18n 语种。

- **用户主动取消（已取消）的问题卡片仍然显示「已回答」**（本版本补漏）：
  - 根因：上版修复只覆盖了「答案文本为空」这一种情形，但用户点击跳过走 `opencode.rejectQuestion` → opencode 内部 `failTool(state, ask.ref, "question rejected")`（见 `packages/opencode/src/cli/cmd/run/demo.ts:1263`），ai-bridge 在 `opencode-daemon-service.js:446` 把这个 error 分支序列化成 `emitToolResultMessage({ content: "question rejected", isError: true })`（marker-protocol 输出字段是 `is_error: Boolean(isError)`），前端 `ToolResultBlock.is_error === true` 且 `content` 非空 —— 仅看文本长度会被算成「已回答」。
  - 修复：把 `answered?: boolean` 替换成 `status: 'answered' | 'cancelled' | 'unanswered'` 三态枚举：
    - `is_error === true` **或** `content` 含字面量 `"question rejected"` → `'cancelled'`（⊘ + 「已取消」暖色徽章，`codicon-circle-slash`）。**字面量兜底**用于兼容老 daemon / 部分序列化路径不写 `is_error` 的场景。
    - 解析到 `"q"="a"` 对 → `'answered'`（✓ + 「已回答」绿）
    - 兜底 → `'unanswered'`（? + 「未回答」灰）
  - **关键操作坑**：上一轮改完代码后发现仍未生效 —— 原因是 `webview/dist/index.html` 和 `dist/webview/index.html` 都比源文件旧得多，**webview 没重新构建**。改完代码必须跑一次 `cd webview && pnpm run build`（包含 tsc + vite build + `scripts/copy-dist.mjs` 把单文件 bundle 同步到 `../dist/webview/index.html`），光改 src/ 是没用的（webview 是 inline-打包的单 HTML，扩展宿主加载的是 dist 里那份）。
  - 关于「超时取消」：opencode 服务端目前没有"超时自动 reject"路径，所有 reject 都走同一个 `failTool(..., "question rejected")`，前端无标记可区分主动 skip 与系统超时。按用户原话"没值就显示已取消"统一显示「已取消」，后续若 opencode 增加区分再扩展。
  - 影响文件：`QuestionAnswerSummary.tsx`（新增 `QuestionSummaryStatus` 类型 + 状态映射表）、`ContentBlockRenderer.tsx`（新增 `isCancelled` 分支 + 答案解析 + 字面量兜底）、`QuestionAnswerSummary.css`（`.qas-cancelled-badge` 暖色样式）、`QuestionAnswerSummary.test.tsx`（新增 4 个 cancelled 用例，包含字面量兜底回归）、10 个 i18n 语种（新增 `askUserQuestion.cancelledStatus`）。

- **清理失效的 `claudeCodeInterrupted` / `claudeCodeError` 映射**（原待后续 #4）：
  - 根因：`localizationUtils.ts` 的 `aiBridgeMessageMap` 按英文原串 `'Claude Code error:'` / `'Claude Code was interrupted…'` 精确匹配，但 `ai-bridge` 已不再产出这些串（仅剩注释与模型提示词里的 "Claude Code"），映射永不命中，纯死代码。
  - 修复：删除这两条死映射项。对应 i18n key（`aiBridge.claudeCodeInterrupted` / `aiBridge.claudeCodeError`）暂留（无害的孤立字符串，避免跨 10 语种改动）。
  - 影响文件：`webview/src/utils/localizationUtils.ts`。

## 待后续版本处理（Deferred）

| # | 项目 | 现状 / 根因 | 影响文件 | 建议 |
|---|------|------------|----------|------|
| 1 | 历史列表「转换为 CLI 会话」按钮 | 死代码：前端发 `convert_to_cli_session`，但 `src/` 20 个 handler 与 `ai-bridge/` 均无对应实现；因 `src/host/session/SessionHistoryStore.ts` 恒写 `entrypoint: 'sdk'`（不在 `CONVERTIBLE_ENTRYPOINTS`），该按钮当前不可见 | `HistoryListItem.tsx`、`useSessionManagement.ts`、`i18n` 的 `history.convertConfirmMessage` | 后续要么在宿主补 `convert_to_cli_session` 实现，要么移除前端按钮与相关 i18n |
| 2 | 设置页 `claudeCliPath`（Claude CLI 路径）整套 UI | opencode-only 模式下为死代码；用户确认页面上已不存在，暂挂起 | `settings/index.tsx`、`BasicConfigSection/EnvironmentTab.tsx`、`useSettingsBasicActions.ts`、`useSettingsWindowCallbacks.ts`、`global.d.ts`、`i18n` 的 `settings.basic.claudeCliPath.*` | 后续确认是否彻底移除该配置项及其 host 接线 |
| 3 | 内部标识符 `ClaudeMessage`、`setClaudePermissionMode`、`claude-vscode` entrypoint key 等 | 非用户可见标识符；改名需改动数十个文件，且 `claude-vscode` 是真实的 entrypoint 值 | 多处 | 暂不改；如要统一品牌，后续单独评估改名成本 |

## 备注
- 上述 `claude-*` / `Claude` 字样中，属底层 SDK 真实行为（如环境变量 `CLAUDE_DEBUG`、`CLAUDE_CODE_*`、模型 id `claude-*` 检测、`.claude` 目录保护）的部分**不是品牌残留，请勿改动**。
- 模型列表加载失败的根因（`ai-bridge` 依赖缺失）已于本版本修复，不在本清单内。
