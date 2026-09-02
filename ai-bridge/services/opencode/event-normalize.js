/**
 * event-normalize.js
 *
 * Pure normalizers for opencode SSE permission / question events.
 *
 * Two wire shapes exist in the wild:
 *   v1: fields directly on `properties`  — { id, sessionID, questions|permission... }
 *   v2: same payload nested under `properties.data`
 * Both must map onto the canonical request object the host hands to the
 * webview dialogs.
 */

/**
 * Normalize a permission event (v1 `permission.asked` / v2 `permission.v2.asked`)
 * into a canonical request object for the host.
 *
 * v1 data: { id, sessionID, permission, patterns }
 * v2 data: { id, sessionID, action, resources, save? }
 *
 * @param {object} props - event properties (with optional nested `data` for v2)
 * @returns {object}
 */
export function normalizePermissionRequest(props) {
  const data = (props && typeof props.data === 'object') ? props.data : (props || {});
  const permissionId = data.id ?? props?.permissionId ?? props?.id ?? '';
  const resources = Array.isArray(data.resources)
    ? data.resources
    : Array.isArray(data.patterns)
      ? data.patterns
      : [];
  const tool = data.action ?? data.permission ?? props?.tool ?? '';
  // opencode attaches the originating tool call to permission requests
  // (data.tool.callID). Carry it through so the webview can anchor the card to
  // that exact tool_use block. Without it the card can only try to match the
  // action name against the block's tool name, and when that fails it renders
  // at the bottom of the conversation instead of inline.
  const toolCallId = (data.tool && typeof data.tool === 'object')
    ? (data.tool.callID ?? data.tool.messageID ?? '')
    : '';
  const toolUseId = toolCallId || permissionId;
  return {
    type: 'permission',
    sessionId: data.sessionID ?? props?.sessionID ?? undefined,
    permissionId,
    toolUseId,
    // The host reads the snake_case alias (see MessageHandler); keep both
    // spellings so either naming convention resolves to the same call id.
    tool_use_id: toolUseId,
    tool,
    toolName: tool,
    description: resources.join(', '),
    inputs: { command: tool, patterns: resources },
  };
}

/**
 * Normalize a question event (v1 `question.asked` / v2 `question.v2.asked`)
 * into a canonical request object for the host.
 *
 * v1/v2 data: { id, sessionID, questions: [QuestionInfo], tool? }
 *
 * @param {object} props - event properties (with optional nested `data` for v2)
 * @returns {object}
 */
export function normalizeQuestionRequest(props) {
  const data = (props && typeof props.data === 'object') ? props.data : (props || {});
  const tool = (data.tool && typeof data.tool === 'object')
    ? (data.tool.callID ?? data.tool.messageID ?? '')
    : (props?.tool ?? '');
  const questions = Array.isArray(data.questions)
    ? data.questions.map((q) => ({
        question: q.question ?? q.text ?? '',
        header: q.header ?? '',
        multiSelect: Boolean(q.multiple ?? q.multiSelect),
        custom: q.custom !== false,
        options: Array.isArray(q.options) ? q.options : [],
      }))
    : [];
  return {
    type: 'question',
    sessionId: data.sessionID ?? props?.sessionID ?? undefined,
    requestId: data.id ?? props?.requestId ?? props?.id ?? '',
    tool,
    questions,
  };
}
