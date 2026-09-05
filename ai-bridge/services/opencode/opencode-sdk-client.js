/**
 * opencode-sdk-client.js
 *
 * Thin wrapper around the @opencode-ai/sdk v2 client for the persistent bridge.
 * Ported from the reference implementation
 * (opencode-x/src/webviewHost/services/OpenCodeClient.ts).
 *
 * The v2 SDK uses FLAT parameter format:
 *   { sessionID, directory, model, agent, parts, ... }
 * NOT the v1 nested format:
 *   { path: { id }, query: { directory }, body: { ... } }
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

let _client = null;
let _baseUrl = null;

/**
 * Get (creating on first use) the shared SDK client bound to the running
 * `opencode serve` instance.
 *
 * @param {string} [baseUrl] - server URL (http://localhost:4096)
 * @returns {ReturnType<typeof createOpencodeClient>}
 */
export function getClient(baseUrl = 'http://localhost:4096') {
  if (!_client || _baseUrl !== baseUrl) {
    _baseUrl = baseUrl;
    _client = createOpencodeClient({ baseUrl });
  }
  return _client;
}

/**
 * Reset the cached client (e.g. when the serve process is restarted on a
 * different port or the server URL changes).
 */
export function resetClient() {
  _client = null;
  _baseUrl = null;
}

/**
 * Rebind the client to a (possibly different) server URL. The actual client is
 * created lazily on the next call that needs it, so this is cheap even when the
 * URL hasn't changed.
 *
 * @param {string} baseUrl - server URL (http://localhost:4096)
 */
export function setBaseUrl(baseUrl) {
  if (_baseUrl !== baseUrl) {
    _client = null;
    _baseUrl = baseUrl;
  }
}

// ── Health ────────────────────────────────────────────────────────────────

/**
 * Ping the server by listing sessions.
 * @returns {Promise<boolean>}
 */
export async function health() {
  try {
    const client = getClient();
    const result = await client.session.list();
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────

/**
 * @param {string} [title]
 * @param {string} [directory]
 * @returns {Promise<object>} the created session (with `id`)
 */
export async function createSession(title, directory) {
  const params = {};
  if (title) params.title = title;
  if (directory) params.directory = directory;
  const result = await getClient().session.create(params);
  if (result.error) {
    throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>}
 */
export async function listSessions(directory) {
  const params = {};
  if (directory) params.directory = directory;
  const result = await getClient().session.list(params);
  if (result.error) {
    throw new Error(`Failed to list sessions: ${JSON.stringify(result.error)}`);
  }
  return result.data ?? [];
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {Promise<object | null>}
 */
export async function getSession(id, directory) {
  const params = { sessionID: id };
  if (directory) params.directory = directory;
  const result = await getClient().session.get(params);
  if (result.error) return null;
  return result.data;
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function deleteSession(id, directory) {
  const params = { sessionID: id };
  if (directory) params.directory = directory;
  const result = await getClient().session.delete(params);
  if (result.error) {
    throw new Error(`Failed to delete session: ${JSON.stringify(result.error)}`);
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────

/**
 * Send a prompt asynchronously to a session (returns once queued; streaming
 * arrives over the SSE event stream).
 *
 * @param {string} sessionId
 * @param {string} text
 * @param {object} [options]
 * @param {{ providerID: string, modelID: string }} [options.model]
 * @param {string} [options.system]
 * @param {string} [options.agent]
 * @param {Record<string, boolean>} [options.tools]
 * @param {string} [options.directory]
 * @param {string} [options.messageID]
 * @param {Array<object>} [options.parts] - extra parts (e.g. file parts for images)
 * @returns {Promise<void>}
 */
export async function promptAsync(sessionId, text, options = {}) {
  const params = {
    sessionID: sessionId,
    parts: [{ type: 'text', text }],
  };
  if (options.messageID) params.messageID = options.messageID;
  if (options.model) params.model = options.model;
  if (options.variant) params.variant = options.variant;
  if (options.system) params.system = options.system;
  if (options.agent) params.agent = options.agent;
  if (options.tools) params.tools = options.tools;
  if (options.directory) params.directory = options.directory;
  if (Array.isArray(options.parts) && options.parts.length > 0) {
    params.parts = [...params.parts, ...options.parts];
  }

  console.error('[opencode-sdk-client] promptAsync:', JSON.stringify(params));
  const result = await getClient().session.promptAsync(params);
  if (result.error) {
    throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Run a shell command in the session context (opencode `!` semantics).
 * The server executes the command, records it as a bash tool part, and
 * streams an AI reply over SSE (same as promptAsync).
 *
 * @param {string} sessionId
 * @param {string} command - shell command WITHOUT the leading `!`
 * @param {object} [options]
 * @param {{ providerID: string, modelID: string }} [options.model]
 * @param {string} [options.agent]
 * @param {string} [options.directory]
 * @returns {Promise<void>}
 */
export async function shellAsync(sessionId, command, options = {}) {
  const params = {
    sessionID: sessionId,
    command,
  };
  if (options.model) params.model = options.model;
  if (options.agent) params.agent = options.agent;
  if (options.directory) params.directory = options.directory;

  console.error('[opencode-sdk-client] shell:', JSON.stringify(params));
  const result = await getClient().session.shell(params);
  if (result.error) {
    throw new Error(`Shell failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {string} [options.agent]
 * @param {string} [options.directory]
 * @param {string} [options.messageID]
 * @param {string} [options.arguments]
 * @returns {Promise<object>}
 */
export async function sendCommand(sessionId, command, options = {}) {
  const params = {
    sessionID: sessionId,
    command,
    arguments: options.arguments ?? '',
  };
  if (options.messageID) params.messageID = options.messageID;
  if (options.model) params.model = options.model;
  if (options.agent) params.agent = options.agent;
  if (options.variant) params.variant = options.variant;
  if (options.directory) params.directory = options.directory;
  if (Array.isArray(options.parts) && options.parts.length > 0) params.parts = options.parts;

  console.error('[opencode-sdk-client] sendCommand:', JSON.stringify(params));
  const result = await getClient().session.command(params);
  if (result.error) {
    throw new Error(`Command failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Abort an active session turn.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function abort(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.abort(params);
  if (result.error) {
    throw new Error(`Abort failed: ${JSON.stringify(result.error)}`);
  }
}

// ── Session share / revert / fork ─────────────────────────────────────────

/**
 * Summarize a session to reduce context size (opencode `/compact` semantics).
 *
 * 服务端 summarize 端点要求请求体 `{ providerID, modelID }`（缺省时返回
 * BadRequest "Expected object, got undefined"），因此这里必须先解析出会话
 * 实际使用的模型（见 resolveSummarizeModel）。
 *
 * @param {string} sessionId
 * @param {string} [directory]
 * @param {string} [model] host UI 选择的模型（"provider/model"，缺省表示用 opencode 默认）
 * @returns {Promise<void>}
 */
export async function summarizeSession(sessionId, directory, model) {
  const resolved = await resolveSummarizeModel(model, sessionId, directory);
  console.error(`[summarize] model resolved: ${resolved ? `${resolved.providerID}/${resolved.modelID}` : 'FAILED (null)'}`);
  if (!resolved) {
    throw new Error('Summarize failed: cannot resolve model for session');
  }
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  // v2 flat 参数格式：providerID/modelID 由 SDK 归入请求体 body。
  params.providerID = resolved.providerID;
  params.modelID = resolved.modelID;
  console.error(`[summarize] POST /session/${sessionId}/summarize — waiting for LLM completion...`);
  const startedAt = Date.now();
  const result = await getClient().session.summarize(params);
  console.error(`[summarize] HTTP returned after ${Date.now() - startedAt}ms, error=${result.error ? JSON.stringify(result.error) : 'none'}`);
  if (result.error) {
    throw new Error(`Summarize failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Resolve the model to summarize with, in priority order:
 *   1. host UI 选择（"provider/model" 字符串）；
 *   2. 会话运行时记录的模型（opencode 权威来源，session.model = { providerID, id }）；
 *   3. 最后一条 assistant 消息实际使用的模型。
 * 全部缺失（理论上仅空会话）时返回 null，由调用方报错。
 *
 * @param {string|undefined} model
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<{ providerID: string, modelID: string } | null>}
 */
async function resolveSummarizeModel(model, sessionId, directory) {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    if (trimmed) {
      const slash = trimmed.indexOf('/');
      if (slash > 0 && slash < trimmed.length - 1) {
        return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
      }
    }
  }

  const session = await getSession(sessionId, directory);
  const sessionProviderID = typeof session?.model?.providerID === 'string' ? session.model.providerID.trim() : '';
  const sessionModelID = typeof session?.model?.id === 'string' ? session.model.id.trim() : '';
  if (sessionProviderID && sessionModelID) {
    return { providerID: sessionProviderID, modelID: sessionModelID };
  }

  const messages = await listMessages(sessionId, directory);
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (
      info?.role === 'assistant'
      && typeof info.providerID === 'string' && info.providerID
      && typeof info.modelID === 'string' && info.modelID
    ) {
      return { providerID: info.providerID, modelID: info.modelID };
    }
  }
  return null;
}

/**
 * Create a shareable link for a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<object | null>} `{ url, ... }` on success
 */
export async function shareSession(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][ShareSession] request sessionID=${sessionId} directory=${directory ?? '-'}`);
  const result = await getClient().session.share(params);
  console.error(`[DEBUG][ShareSession] result.error=${JSON.stringify(result.error ?? null)} data=${JSON.stringify(result.data ?? null)}`);
  if (result.error) {
    throw new Error(`Share failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Remove the shareable link for a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function unshareSession(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.unshare(params);
  if (result.error) {
    throw new Error(`Unshare failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Revert the session to the state before a given message.
 * @param {string} sessionId
 * @param {string} messageID
 * @param {string} [directory]
 * @returns {Promise<object | null>} updated session
 */
export async function revertSession(sessionId, messageID, directory) {
  const params = { sessionID: sessionId, messageID };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][RevertSession] request sessionID=${sessionId} messageID=${messageID}`);
  const result = await getClient().session.revert(params);
  console.error(`[DEBUG][RevertSession] result.error=${JSON.stringify(result.error ?? null)}`);
  if (result.error) {
    throw new Error(`Revert failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Restore all previously reverted messages in a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<object | null>} updated session
 */
export async function unrevertSession(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][UnrevertSession] request sessionID=${sessionId}`);
  const result = await getClient().session.unrevert(params);
  console.error(`[DEBUG][UnrevertSession] result.error=${JSON.stringify(result.error ?? null)}`);
  if (result.error) {
    throw new Error(`Unrevert failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Fork a session at an optional message point. Returns the new session.
 * @param {string} sessionId
 * @param {string} [messageID]
 * @param {string} [directory]
 * @returns {Promise<object | null>} the forked session (with `id`)
 */
export async function forkSession(sessionId, messageID, directory) {
  const params = { sessionID: sessionId };
  if (messageID) params.messageID = messageID;
  if (directory) params.directory = directory;
  console.error(`[DEBUG][ForkSession] request sessionID=${sessionId} messageID=${messageID ?? '-'}`);
  const result = await getClient().session.fork(params);
  console.error(`[DEBUG][ForkSession] result.error=${JSON.stringify(result.error ?? null)} data.id=${result.data?.id ?? '-'}`);
  if (result.error) {
    throw new Error(`Fork failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

// ── SSE Events (real-time streaming) ──────────────────────────────────────

/**
 * Subscribe to the opencode SSE event stream.
 * Returns an async iterable of parsed events. Pass `signal` to close it.
 *
 * @param {string} [directory]
 * @param {AbortSignal} [signal]
 * @returns {Promise<AsyncIterable<object>>}
 */
export async function subscribeEvents(directory, signal) {
  const params = {};
  if (directory) params.directory = directory;
  const options = {};
  if (signal) options.signal = signal;
  const { stream } = await getClient().event.subscribe(params, options);
  return stream;
}

// ── Config ────────────────────────────────────────────────────────────────

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} provider list, each with `.models` keyed by model id
 */
export async function getProviders(directory) {
  const params = {};
  if (directory) params.directory = directory;
  const result = await getClient().config.providers(params);
  if (result.error) return [];
  const data = result.data;
  const providers = data?.providers ?? [];
  // Attach default-model map (per provider) for convenience.
  const defaults = data?.defaults ?? data?.default;
  for (const p of providers) {
    if (defaults) p._defaults = defaults;
    const opts = p?.options;
    p._isPublicKey = opts?.apiKey === 'public';
  }
  return providers;
}

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} agent list
 */
export async function getAgents(directory) {
  const params = {};
  if (directory) params.directory = directory;
  const result = await getClient().app.agents(params);
  if (result.error) return [];
  return result.data ?? [];
}

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} command list
 */
export async function getCommands(directory) {
  try {
    const params = {};
    if (directory) params.directory = directory;
    const result = await getClient().command.list(params);
    if (result.error) return [];
    return result.data ?? [];
  } catch {
    return [];
  }
}

// ── Permissions & Questions ───────────────────────────────────────────────

/**
 * Reply to a pending v2 permission request. The generated v2 client maps flat
 * params via path/body spec keys: `requestID` lives in the path, `reply` in the
 * body (PermissionV2Reply = "once" | "always" | "reject").
 *
 * @param {string} sessionId
 * @param {string} permissionID - the request id from `permission.*.asked` `data.id`
 * @param {'once' | 'always' | 'reject'} reply
 * @param {string} [message]
 * @returns {Promise<void>}
 */
export async function replyPermission(sessionId, permissionID, reply, message, directory) {
  const client = getClient();
  const params = { requestID: permissionID, reply };
  if (message) params.message = message;
  if (directory) params.directory = directory;
  const result = await client.permission.reply(params);
  if (result.error) {
    throw new Error(`replyPermission failed (${permissionID}): ${summarizeError(result.error)}`);
  }
  console.error('[DEBUG][OpenCodeDaemon] permission replied ok:', permissionID, '→', reply);
}

/**
 * Reply to a pending question request. `answers` is an ordered array (one
 * element per `data.questions` entry) of selected label arrays
 * (QuestionAnswer = string[]).
 *
 * Uses v1 endpoint `/question/{requestID}/reply` which accepts a `directory`
 * query parameter for server-side project scoping.
 *
 * @param {string} sessionId
 * @param {string} questionID - the request id from `question.*.asked` `data.id`
 * @param {string[][]} answers
 * @param {string} [directory] - project directory for server-side scoping
 * @returns {Promise<void>}
 */
export async function replyQuestion(sessionId, questionID, answers, directory) {
  const client = getClient();
  const params = {
    requestID: questionID,
    answers: Array.isArray(answers) ? answers : [],
  };
  if (directory) params.directory = directory;
  console.log(`[sdk] replyQuestion params=${JSON.stringify({ requestID: questionID, directory })}`);
  const result = await client.question.reply(params);
  console.log(`[sdk] replyQuestion result=${JSON.stringify(result).substring(0, 500)}`);
  if (result.error) {
    throw new Error(`replyQuestion failed (${questionID}): ${summarizeError(result.error)}`);
  }
  console.log(`[sdk] replyQuestion OK questionID=${questionID}`);
}

/**
 * @param {string} sessionId
 * @param {string} questionID
 * @returns {Promise<void>}
 */
export async function rejectQuestion(sessionId, questionID, directory) {
  const client = getClient();
  const params = { requestID: questionID };
  if (directory) params.directory = directory;
  const result = await client.question.reject(params);
  if (result.error) {
    throw new Error(`rejectQuestion failed (${questionID}): ${summarizeError(result.error)}`);
  }
  console.error('[DEBUG][OpenCodeDaemon] question rejected ok:', questionID);
}

/**
 * Compact, log-safe summary of a HeyApi/HTTP error object for error messages.
 * @param {unknown} error
 * @returns {string}
 */
function summarizeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const err = error;
  const status = err.status ?? err.response?.status;
  const body = err.detail ?? err.body ?? err.message ?? err.error;
  let bodyText = '';
  if (body != null) {
    try { bodyText = typeof body === 'string' ? body : JSON.stringify(body); } catch { bodyText = String(body); }
  }
  return `${status ? `HTTP ${status}` : 'error'}${bodyText ? `: ${String(bodyText).slice(0, 300)}` : ''}`;
}

// ── Messages ──────────────────────────────────────────────────────────────

/**
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<object[]>} message entries `{ info, parts }`
 */
export async function listMessages(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.messages(params);
  if (result.error) return [];
  return result.data ?? [];
}

// ── Filesystem ───────────────────────────────────────────────────────────

/**
 * Find ranked filesystem entries via the server `fs.find` endpoint —— 与
 * opencode TUI @-mention 列表同源（服务端 fff 引擎已完成 frecency + 模糊
 * 排序，调用方直接信任顺序）。
 *
 * @param {object} [options]
 * @param {string} [options.query] search text (empty → default ranked set)
 * @param {string} [options.limit] e.g. "20"
 * @param {string} [options.directory] base directory for relative paths
 * @returns {Promise<Array<{ path: string, type: 'file' | 'directory' }>>}
 */
export async function findFiles({ query = '', limit = '20', directory } = {}) {
  const params = { query, limit };
  if (directory) params.location = { directory };
  // fs 在 v2 子命名空间下（同 TUI：sdk.client.v2.fs.find）。
  const result = await getClient().v2.fs.find(params);
  if (result.error) return [];
  return result.data?.data ?? [];
}

// ── MCP ──────────────────────────────────────────────────────────────────

/**
 * Enumerate MCP server connection status via `mcp.status`.
 * @param {string} [directory]
 * @returns {Promise<Array<{ name: string, status?: string, error?: string }>>}
 */
export async function getMcpStatus(directory) {
  try {
    const params = {};
    if (directory) params.directory = directory;
    const result = await getClient().mcp.status(params);
    if (result.error) return [];
    const map = result.data ?? {};
    if (!map || typeof map !== 'object') return [];
    return Object.entries(map).map(([name, status]) => {
      const info = status && typeof status === 'object' ? status : {};
      return {
        name,
        status: typeof info.status === 'string' ? info.status : 'unknown',
        error: typeof info.error === 'string' ? info.error : undefined,
      };
    });
  } catch {
    return [];
  }
}
