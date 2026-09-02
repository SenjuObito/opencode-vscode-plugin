/**
 * Shared bridge marker protocol used by CLI providers (Grok / Kimi / OpenCode).
 * Java MarkerCliBridge parses these lines into MessageCallback events.
 */

export function emitJsonStringMarker(tag, text) {
  process.stdout.write(`${tag} ${JSON.stringify(text)}\n`);
}

export function emitSendError(message, label = 'CLI') {
  console.log(`[SEND_ERROR] ${JSON.stringify({ error: String(message || `Unknown ${label} error`) })}`);
}

export function emitSessionId(sessionId) {
  if (sessionId) {
    console.log(`[SESSION_ID] ${sessionId}`);
  }
}

export function emitUsage(usage) {
  if (usage && typeof usage === 'object') {
    console.log(`[USAGE] ${JSON.stringify(usage)}`);
  }
}

export function emitMessageMarker(messageObject) {
  console.log(`[MESSAGE] ${JSON.stringify(messageObject)}`);
}

/**
 * Begin a stream. When `sessionId` is supplied, it is appended to the
 * `[MESSAGE_START]` line (`[MESSAGE_START] <sessionId>`) so the host can
 * capture the canonical session id from the very first marker (opencode).
 */
export function beginStream(sessionId) {
  console.log(sessionId ? `[MESSAGE_START] ${sessionId}` : '[MESSAGE_START]');
  console.log('[STREAM_START]');
}

/**
 * End a stream. When `message` (object) is supplied it is JSON-serialized onto
 * the `[MESSAGE_END]` line; when `sessionId` is supplied it is appended to
 * `[STREAM_END]` (opencode). Bare calls keep the legacy tag-only output.
 * @param {{ sessionId?: string, message?: object }} [opts]
 */
export function endStream({ sessionId, message } = {}) {
  if (message) {
    console.log(`[MESSAGE_END] ${JSON.stringify(message)}`);
  } else {
    console.log('[MESSAGE_END]');
  }
  console.log(sessionId ? `[STREAM_END] ${sessionId}` : '[STREAM_END]');
}

/**
 * Emit Claude-compatible tool_use / tool_result MESSAGE markers.
 */
export function emitToolUseMessage({ id, name, input }) {
  const safeInput = input && typeof input === 'object' ? input : {};
  console.error(`[DEBUG emitToolUse] name=${name} id=${id} inputKeys=${Object.keys(safeInput)} inputPreview=${JSON.stringify(safeInput).substring(0, 300)}`);
  emitMessageMarker({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: id || 'tool-1',
          name: name || 'tool',
          input: input && typeof input === 'object' ? input : {},
        },
      ],
    },
  });
}

export function emitToolResultMessage({ toolUseId, content, isError = false }) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  emitMessageMarker({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId || 'tool-1',
          is_error: Boolean(isError),
          content: text,
        },
      ],
    },
  });
}

export function safePromptArg(text) {
  if (typeof text === 'string' && text.startsWith('-')) {
    return ` ${text}`;
  }
  return text ?? '';
}

export function isNonEmptySessionId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed.includes('..')) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  return true;
}
