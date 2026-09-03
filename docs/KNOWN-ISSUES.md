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

- **用户已回答的 askUserQuestion 卡片显示「未回答」（本版本反向修复）**：
  - 根因：`QuestionAnswerSummary.parseAnswersFromOutput` 只识别 opencode 协议格式 `"question"="answer"`，但 `ContentBlockRenderer` 的 **storedQA 路径**（用户在 webview 弹窗里回答 → host 调 `onQuestionAnswered` → `setQuestionAnswer` 进 store）合成的内容是 `"question\nanswer"` 换行分隔格式。两者不一致 → answered text 非空但 parser 解析 0 对 → 落到 `parsedAnswerCount === 0` → 状态判成 `'unanswered'`。
  - 修复两步：
    1. **`QuestionAnswerSummary`** 新增 `answers?: Map<string, string>` 可选 prop —— 结构化 answers 来自 storedQA 路径时直接传 Map，绕过 string parsing。
    2. **`parseAnswersFromOutput`** 改为多格式兼容：协议格式 `"q"="a"` 优先命中 → 否则 `\n\n` 分隔 + `\n` 切 question/answer 的回退解析（对应 storedQA 合成的格式）。同时 `parseAnswersFromOutput(output, answers)` 在 `answers` 非空时直接返回，structured map 总是赢过字符串。
    3. **`ContentBlockRenderer`** 同时构造 `storedAnswers: Map<string, string>` 并传给 `<QuestionAnswerSummary answers={storedAnswers}>`。`parsedAnswerCount` 改为优先用 `storedAnswers.size`，再走 parser 兜底。
  - **认识论教训**：上一轮我只看了"已取消误判成已回答"，加完 is_error 判断就停手了，没覆盖"已回答误判成未回答"的对称场景。**单 bug 修复不应只看单一方向**——最好把所有可行输入空间列一遍（取消 / 未答 / 答 / 多选），避免来回打补丁。
  - 影响文件：`QuestionAnswerSummary.tsx`（新增 `answers` prop + parser 双格式）、`ContentBlockRenderer.tsx`（storedQA 路径构造 Map 并下传 + parsedAnswerCount 多格式计数）、`QuestionAnswerSummary.test.tsx`（新增 2 个用例：换行格式回退 + structured prop 优先；现 11 个测试）。

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
