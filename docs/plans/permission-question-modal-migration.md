# 权限卡 / 提问卡改为独立弹窗（对齐 opencode TUI / cc-gui）

## 背景与目标
当前 webview 把"权限请求"和"提问（AskUserQuestion）"作为**内联卡片**渲染在 `MessageList` 里，
用 `afterMessageIndex` 锚点 + `claimed` 占用集 + 锚点升序排序来对齐消息位置。这套机制脆弱（索引漂移、
折叠/撤销区钳制、并发多卡叠位）。

目标：参考 cc-gui（`PermissionDialog.tsx` / `AskUserQuestionDialog.tsx`）与现有 `PlanApprovalDialog`，
把这两类请求改为**顶层居中模态弹窗**，一次一个、用完即走，**作答后对话流不留记录**（与 opencode TUI 一致）。

## 关键事实（已核实）
- 我们的 `AppDialogs.tsx` 已经用同样模态模式渲染 `PlanApprovalDialog`、`ContextUsageDialog`、`Rewind*`、`ConfirmDialog`，
  且 `permissionDialogTimeoutSeconds` 已透传到 `PlanApprovalDialog`——弹窗管线本就存在。
- 除权限/提问外，其余"后端异步事件触发的交互"在我们与 cc-gui 里都是顶层模态，MessageList 内联卡片仅此两类。
- **审批超时逻辑是独立管线，不能丢**：
  - 设置项 `PermissionDialogTimeoutSetting.tsx`（`settings.basic.permissionDialogTimeout.label`，30–3600s，默认 300）
    → `App.tsx` 状态 `permissionDialogTimeoutSeconds` → `ChatScreen` → `AppDialogs` 透传。
  - 倒计时内核 `useDialogCountdownTimeout.ts`（`markSubmitted` 防重复 + 30s 警告 + 到点 `onTimeout`）+ `permissionDialogTimeout.ts`（夹取）。
  - 宿主可经 `window.updatePermissionDialogTimeout` 推送新值。
  - 行为契约：权限超时 → `onDeny`；提问超时 → `onSkip`；作答后 `markSubmitted` 兜底防重复提交。
- `PermissionRequest` / `AskUserQuestionRequest` 字段形状与本仓库及 cc-gui 一致：
  - `PermissionRequest { channelId, toolName, inputs, suggestions? }`
  - `AskUserQuestionRequest { requestId, toolName, questions, provider? }`

## 改动清单

### 1. `webview/src/hooks/useDialogManagement.ts`（状态模型改队列）
- 删除 `permissionCards` / `questionCards` 数组（含 `afterMessageIndex` 捕获、`messagesRef` 锚点代码）。
- 新增每种各一套：`*DialogOpen`、`current*Request`、`pending*Requests[]`（数组队列）。
- `openPermissionDialog` / `openAskUserQuestionDialog`：入队；若当前无激活则提升队首为 `current` 并 `open=true`。
- `handlePermissionApprove/Always/Skip`、`handleAskUserQuestionSubmit/Skip`：发送既有 bridge 事件
  （`permission_decision` / `ask_user_question_response` / `ask_user_question_reject`），关闭 `current`，从队列提升下一个。
- 删除 `invalidatePermissionCard` / `invalidateQuestionCard`（"不留记录"：host 回复失败直接关闭当前请求即可，
  用 `forceClose*` 语义覆盖）。若宿主仍调用，保留同名函数改为"关闭当前/移除 pending"。
- `forceClosePermissionDialog` / `forceCloseAskUserQuestionDialog`：移除指定/全部 pending，并关闭匹配的 current。
- 会话切换清队列逻辑保留（原 `useEffect` 清空卡片 → 清空队列）。
- 请求类型改从新模态组件导入（`../components/PermissionDialog`、`../components/AskUserQuestionDialog`）。

### 2. 新增 `webview/src/components/PermissionDialog.tsx`
- 移植 cc-gui `PermissionDialog.tsx`：居中模态 `permission-dialog-overlay` + 超时倒计时（`useDialogCountdownTimeout`）
  + `approve` / `skip` / `approveAlways` + 命令预览（`getCommandContent` / `getWorkingDirectory`）。
- props：`isOpen`, `request`, `onApprove`, `onSkip`, `onApproveAlways`, `timeoutSeconds`。
- `handleTimeout` → `onSkip(request.channelId)`；保留 `markSubmitted` 与键盘快捷键（1/2/3、`↑↓+Enter`、`Esc=拒绝`）。
- **opencode-only**：去掉 cc-gui 里 `provider === 'codex'` 分支；标题用 opencode 文案。
- CSS：新增 `PermissionDialog.css`（或沿用现有 `permission-dialog-overlay` 样式）。

### 3. 新增 `webview/src/components/AskUserQuestionDialog.tsx`
- 移植 cc-gui 同名组件：多问题分页、多选、`Other` 自定义输入、超时倒计时、折叠。
- props：`isOpen`, `request`, `onSubmit`, `onCancel`, `timeoutSeconds`。
- `handleTimeout` → `onCancel(request.requestId)`。
- 去掉 cc-gui `isCodexRequest` / `request_user_input` 的 codex 分支；标题用 opencode 文案。
- CSS：新增 `AskUserQuestionDialog.css`。

### 4. `webview/src/components/AppDialogs.tsx`（挂载）
- 把第 160-161 行注释替换为：
  ```tsx
  <PermissionDialog isOpen={permissionDialogOpen} request={currentPermissionRequest}
    onApprove={handlePermissionApprove} onSkip={handlePermissionSkip}
    onApproveAlways={handlePermissionApproveAlways} timeoutSeconds={permissionDialogTimeoutSeconds} />
  <AskUserQuestionDialog isOpen={askUserQuestionDialogOpen} request={currentAskUserQuestionRequest}
    onSubmit={handleAskUserQuestionSubmit} onCancel={handleAskUserQuestionSkip}
    timeoutSeconds={permissionDialogTimeoutSeconds} />
  ```
- 从 `useDialogs()` 取上述新字段（对齐 cc-gui `AppDialogs.tsx`）。

### 5. `webview/src/components/MessageList.tsx`（删除内联卡片）
- 删除 `useMemo` 卡片渲染块（`pending` / `placeCard` / `resolveBlockIndex` / `claimed` 占用集 / 锚点升序 / `cardRenderEntries` / `inlineCardsByMessage`）。
- 删除 `DialogContext` 中 `permissionCards` / `questionCards` 消费与 `PermissionCard` / `QuestionCard` 导入。
- 同步清理 `MessageItem` 里 `inlineCards` 内联插入相关路径（若无其他消费者则一并简化）。

### 6. 删除旧内联组件
- 删除 `webview/src/components/MessageList/PermissionCard.tsx` 与 `QuestionCard.tsx`（及对应 `.css` / `.test.tsx`）。
- 请求类型改由新模态组件导出（第 1 步已改导入）。

### 7. 测试
- `MessageList.test.tsx`：删锚点用例（约 598–918 区段），改断言"MessageList 不再内联渲染权限/提问卡片"；
  移除对 `PermissionCard` / `QuestionCard` 的 mock（除非 `inlineCards` 仍被其他用途使用，则调整）。
- `useDialogManagement.test.ts` / `useDialogManagement.forceClose.test.ts`：改为队列模型断言（current + pending、
  作答后提升下一个、删除 `afterMessageIndex` 断言）。
- 新增 `PermissionDialog.test.tsx` / `AskUserQuestionDialog.test.tsx`：对齐 cc-gui 测试（overlay 渲染、
  approve/skip 调 handler、超时自动关闭、并发请求串行化）。
- `PlanApprovalDialog.test.tsx` 的 countdown 用例可作范本。

### 8. 验证
- `cd webview && pnpm run build`（tsc + vite）。
- 手动：触发需审批命令 → 居中弹窗 + 倒计时；并发多条 → 串行；作答后消失、对话流无残留；
  设置里改"弹窗审批超时" → 新值生效、到点自动拒绝/跳过；会话切换弹窗清空。

## 风险与缓解
- 超时管线：第 4 步把 `permissionDialogTimeoutSeconds` 显式传给两个新模态（目前仅 `PlanApprovalDialog` 接收），确保不丢。
- 并发串行化：沿用 `PlanApprovalDialog` 的 `pending*Requests` 队列 + 提升模式。
- 测试面大：先确保 `pnpm run build` 通过，再补/修单测。

## 参考（cc-gui，位于 /Users/obito/IdeaProjects/jetbrains-cc-gui）
- `webview/src/components/AppDialogs.tsx`（顶层弹窗容器）
- `webview/src/components/PermissionDialog.tsx`
- `webview/src/components/AskUserQuestionDialog.tsx`
