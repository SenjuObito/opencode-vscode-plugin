/**
 * OpenCode message service.
 *
 * Thin facade over the persistent opencode daemon service. All real work
 * (session management, SSE → marker streaming, tool blocks, usage) happens in
 * `opencode-daemon-service.js` via a resident `opencode serve` process + the
 * @opencode-ai/sdk v2 client.
 *
 * The positional signature below is kept for backwards compatibility with the
 * pre-daemon per-process path (and the channel command handlers), but the
 * implementation simply normalizes the arguments and forwards them to
 * `sendMessagePersistent`.
 */

import { sendMessagePersistent } from './opencode-daemon-service.js';

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [_reasoningEffort]
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  _reasoningEffort = '',
  attachments = []
) {
  await sendMessagePersistent({
    message: message ?? '',
    sessionId: sessionId || undefined,
    cwd: cwd || undefined,
    model: model || undefined,
    attachments: Array.isArray(attachments) ? attachments : [],
  });
}
