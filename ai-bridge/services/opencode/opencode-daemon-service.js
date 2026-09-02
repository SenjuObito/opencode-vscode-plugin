/**
 * opencode-daemon-service.js
 *
 * Persistent query service for the opencode bridge (daemon mode).
 *
 * Unlike the old per-process `opencode run --format json` path, this keeps a
 * resident `opencode serve` + one @opencode-ai/sdk v2 client + a single global
 * SSE subscription alive across turns, and maps opencode SSE events straight to
 * the shared marker-protocol lines on stdout.
 *
 * Session state is keyed by `sessionID`: each send registers a "turn" for that
 * session; SSE events are routed by sessionID to the active turn and emitted as
 * markers. `session.idle` / `session.error` settle the turn.
 *
 * ── Stream protocol emitted to stdout (each line wrapped `{id, line}` by daemon) ──
 *   [MESSAGE_START] <sessionId>        canonical session id (create/reuse)
 *   [STREAM_START]
 *   [SESSION_ID] <sessionId>
 *   [CONTENT_DELTA] "<json text>"      text part deltas
 *   [THINKING_DELTA] "<json text>"     reasoning part deltas
 *   [MESSAGE] {...}                    tool_use / tool_result blocks
 *   [PERMISSION_REQUEST] {...}         permission.asked passthrough (Phase 4)
 *   [QUESTION_REQUEST] {...}           question.asked passthrough (Phase 4)
 *   [QUESTION_CLOSED] {...}            question replied/rejected server-side
 *   [PERMISSION_CLOSED] {...}          permission.replied server-side
 *   [USAGE] {...}                      { input_tokens, output_tokens, ... }
 *   [MESSAGE_END] <full message json>
 *   [STREAM_END] <sessionId>
 *   {success, sessionId}               final request-result JSON
 */

import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  beginStream,
  endStream,
  emitJsonStringMarker,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitSendError,
  emitUsage,
} from '../../utils/marker-protocol.js';
import {
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';
import * as serveManager from './opencode-serve-manager.js';
import * as sdk from './opencode-sdk-client.js';
import {
  normalizePermissionRequest,
  normalizeQuestionRequest,
} from './event-normalize.js';
import { requestContext } from '../../request-context.js';

// =============================================================================
// Module state
// =============================================================================

const DEFAULT_PORT = Number(process.env.OPENCODE_PORT) || 4096;

/** @type {boolean} opencode serve has been started (or reused) */
let _serveStarted = false;
/** @type {boolean} SDK client ready + SSE subscribed */
let _sdkPrepared = false;
/**
 * Per-directory SSE subscriptions. opencode's `event.subscribe` is scoped to a
 * working directory — an unscoped subscription only yields global
 * `server.connected`/`server.heartbeat` events, not `session.*`/`message.*`
 * ones. Turns are keyed by sessionID, but a session belongs to a directory, so
 * one stream per distinct directory keeps every turn fed.
 * @type {Map<string, { stream: AsyncIterable<object>, controller: AbortController }>}
 */
const _sseSubs = new Map();
/**
 * In-flight SSE subscription promises per directory, so concurrent first-callers
 * (e.g. preconnect + getModels) do not create duplicate subscriptions.
 * @type {Map<string, Promise<void>>}
 */
const _sseSubPromises = new Map();
/** @type {Map<string, object>} sessionID → turn record */
const _activeTurns = new Map();
/** @type {Map<string, { directory?: string }>} sessionID → session state */
const _sessions = new Map();

// =============================================================================
// Small helpers
// =============================================================================

function logDebug(...args) {
  console.error('[DEBUG][OpenCodeDaemon]', ...args);
}

/**
 * Look up the directory for a sessionID from the session registry.
 * Used by reply/reject calls that need the `directory` query parameter
 * so the opencode server can locate the question/permission in the
 * correct project scope.
 * @param {string} sessionId
 * @returns {string|undefined}
 */
export function getSessionDirectory(sessionId) {
  return sessionId ? _sessions.get(sessionId)?.directory : undefined;
}

/**
 * Parse a `provider/model` (or bare `model`) id into the SDK model object.
 * @param {string|undefined} model
 * @returns {{ providerID: string, modelID: string } | null}
 */
function resolveModelParam(model) {
  if (!model || typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === '__config_default__' || lower === 'auto' || lower === 'default'
    || lower === '(default)' || lower === 'config-default'
    || lower === 'config_default' || lower === 'opencode default'
    || lower === 'opencode-default'
  ) {
    return null;
  }
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
  }
  // Bare model id — let the server resolve the default provider.
  return { providerID: '', modelID: trimmed };
}

/**
 * Resolve the opencode agent/mode. The UI calls it "mode" (cc-gui semantics),
 * opencode calls it "agent". Both are accepted.
 * @param {object} params
 * @returns {string|undefined}
 */
function resolveAgentParam(params) {
  const agent = params?.agent;
  const mode = params?.mode;
  if (typeof agent === 'string' && agent.trim()) return agent.trim();
  if (typeof mode === 'string' && mode.trim()) return mode.trim();
  return undefined;
}

function tokensToUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  return {
    input_tokens: Number(tokens.input) || 0,
    output_tokens: Number(tokens.output) || 0,
    reasoning_tokens: Number(tokens.reasoning) || 0,
    cache_read_input_tokens: Number(cache.read) || 0,
    cache_creation_input_tokens: Number(cache.write) || 0,
  };
}

// =============================================================================
// Serve + SDK + SSE lifecycle
// =============================================================================

/**
 * Ensure `opencode serve` is running and the SDK/SSE plumbing is ready for the
 * given working directory. Idempotent — cheap after the first call, and one SSE
 * subscription is maintained per distinct directory.
 *
 * @param {string} directory - working directory to scope the SSE subscription to
 */
async function _ensureReady(directory) {
  if (!_serveStarted) {
    await serveManager.start(DEFAULT_PORT);
    _serveStarted = true;
  }
  const url = serveManager.getServerUrl() || `http://localhost:${DEFAULT_PORT}`;
  // (Re)bind the SDK client to the actual server URL.
  sdk.setBaseUrl(url);
    if (!_sseSubs.has(directory) && !_sseSubPromises.has(directory)) {
    const subPromise = (async () => {
      const controller = new AbortController();
      const stream = await sdk.subscribeEvents(directory, controller.signal);
      _sseSubs.set(directory, { stream, controller });
      // Kick off the per-directory event loop detached from the request context
      // that created it.  The loop is long-lived; if it inherited a request id,
      // all subsequent SSE events would be mis-tagged to that stale id instead
      // of falling back to the active turn's id.
      requestContext.run({ id: null }, () => {
        _runSseLoop(stream, directory).catch((err) => {
          logDebug('SSE loop exited:', err?.message || err);
        });
      });
    })();
    _sseSubPromises.set(directory, subPromise);
    try {
      await subPromise;
    } finally {
      _sseSubPromises.delete(directory);
    }
  } else if (_sseSubPromises.has(directory)) {
    await _sseSubPromises.get(directory);
  }
  _sdkPrepared = true;
}

async function _runSseLoop(stream, directory) {
  let unexpectedDeath = false;
  try {
    for await (const evt of stream) {
      try {
        _handleEvent(evt);
      } catch (err) {
        logDebug('event handler error:', err?.message || err);
      }
    }
    // The iterator ended without an exception — for a server-sent-events
    // subscription this only happens when the connection died silently.
    const sub = _sseSubs.get(directory);
    if (!(sub && sub.controller.signal.aborted)) {
      unexpectedDeath = true;
    }
  } catch (err) {
    // AbortController.abort() closes the stream with an AbortError — expected on shutdown.
    const sub = _sseSubs.get(directory);
    if (sub && sub.controller.signal.aborted) return;
    logDebug('SSE stream ended unexpectedly:', err?.message || err);
    unexpectedDeath = true;
  } finally {
    // A dead stream must be re-established on the next turn.
    const sub = _sseSubs.get(directory);
    if (sub && sub.stream === stream) {
      _sseSubs.delete(directory);
    }
  }

  if (unexpectedDeath) {
    // Without the event stream no `session.idle` can ever arrive, so any
    // in-flight turns would hang forever. Settle them with an error so the
    // host's send returns and the frontend loading state ends. The stream is
    // re-established on the next request via _ensureReady().
    logDebug('SSE stream died — failing all active turns for', directory);
    for (const [sessionID, turn] of _activeTurns) {
      if (turn.settled) continue;
      logDebug('failing active turn due to SSE death:', sessionID);
      _settleTurn(turn, { success: false, error: { message: 'Event stream disconnected' } });
    }
  }
}

// =============================================================================
// SSE → marker mapping
// =============================================================================

/**
 * Route a single SSE event to its session's active turn (if any) and emit
 * markers. Uses `properties` (the runtime shape, verified against opencode
 * 1.18.x) with a `data` fallback for older/newer servers.
 */
function _handleEvent(evt) {
  const props = (evt && evt.properties && typeof evt.properties === 'object')
    ? evt.properties
    : ((evt && evt.data && typeof evt.data === 'object') ? evt.data : {});
  const type = typeof evt?.type === 'string' ? evt.type : '';
  const sessionID = props?.sessionID;
  const turn = sessionID ? _activeTurns.get(sessionID) : null;

  switch (type) {
    case 'session.created':
    case 'session.updated':
    case 'session.initialize': {
      // Track the session's directory. The [SESSION_ID] marker is emitted by the
      // send/preconnect path itself (authoritative), so we only record state here
      // — and only for sessions we created, so a sibling `opencode` in the same
      // directory can't inject stray session events into our stream.
      const id = sessionID || props?.info?.id;
      if (id && _sessions.has(id)) {
        const revert = props?.info?.revert;
        _sessions.set(id, { 
          directory: props?.info?.directory || _sessions.get(id)?.directory,
          revert,
        });
        // Emit revert state update to frontend
        if (turn) {
          emitJsonStringMarker('[REVERT_STATE]', JSON.stringify({ hasRevert: !!revert }));
        }
      }
      break;
    }
    case 'message.part.updated':
    case 'message.part.created':
      if (turn) _handlePartUpdated(props, turn);
      break;
    case 'message.part.delta':
      if (turn) _handlePartDelta(props, turn);
      break;
    case 'message.updated':
      // Track the latest assistant message info (id/role/tokens) for MESSAGE_END.
      if (turn && props?.info && typeof props.info === 'object') {
        if (props.info.role === 'assistant') turn.lastInfo = props.info;
      }
      break;
    case 'session.idle':
      if (turn) _settleTurn(turn, { success: true });
      break;
    case 'session.error':
      if (turn) {
        const err = props?.error || { message: 'session.error' };
        _settleTurn(turn, { success: false, error: err });
      }
      break;
    // Permission / question prompts — normalize v1+v2 event shapes into a
    // canonical payload the host can hand straight to the webview dialogs.
    case 'permission.asked':
    case 'permissionV2.asked':
    case 'permission.requested': {
      const normalized = normalizePermissionRequest(props);
      logDebug('permission asked:', normalized.permissionId, 'tool:', normalized.tool, 'session:', normalized.sessionId);
      emitJsonStringMarker('[PERMISSION_REQUEST]', normalized);
      break;
    }
    case 'question.asked':
    case 'questionV2.asked': {
      const request = normalizeQuestionRequest(props);
      logDebug('question asked:', request.requestId, 'session:', request.sessionId,
        'tool:', JSON.stringify(request.tool), 'questions:', request.questions.length,
        'rawProps:', JSON.stringify(props).slice(0, 500));
      emitJsonStringMarker('[QUESTION_REQUEST]', request);
      break;
    }
    // Lifecycle close events: the server may resolve/cancel a pending prompt
    // on its own (turn aborted/errored/expired, or answered via another
    // surface). The webview cards must be torn down accordingly or they stay
    // pending forever and later fail with "Question request not found".
    case 'question.replied':
    case 'question.v2.replied':
    case 'questionV2.replied':
    case 'question.rejected':
    case 'question.v2.rejected':
    case 'questionV2.rejected': {
      const requestId = props?.requestID ?? props?.id ?? '';
      logDebug('question closed:', type, requestId);
      if (requestId) {
        emitJsonStringMarker('[QUESTION_CLOSED]', { requestId });
      }
      break;
    }
    case 'permission.replied':
    case 'permission.v2.replied':
    case 'permissionV2.replied': {
      const permissionId = props?.permissionID ?? props?.requestID ?? props?.id ?? '';
      logDebug('permission closed:', type, permissionId);
      if (permissionId) {
        emitJsonStringMarker('[PERMISSION_CLOSED]', { permissionId });
      }
      break;
    }
    case 'todo.updated': {
      const todos = props?.todos;
      if (Array.isArray(todos)) {
        logDebug('todo.updated: session:', sessionID, 'count:', todos.length);
        emitJsonStringMarker('[TODO_UPDATED]', JSON.stringify({ sessionID, todos }));
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Store the full part (needed because `message.part.delta` carries no part.type)
 * and react to tool / step-finish transitions.
 */
function _handlePartUpdated(props, turn) {
  const part = props?.part;
  if (!part || typeof part !== 'object') return;
  const partID = part.id;
  if (partID) turn.parts.set(partID, part);
  const ptype = part.type;
  if (ptype === 'tool') {
    const st = part.state && typeof part.state === 'object' ? part.state : {};
    const inputKeys = st.input && typeof st.input === 'object' ? Object.keys(st.input) : [];
    logDebug('_handlePartUpdated tool:', 'tool:', part.tool || part.name, 'status:', st.status, 'inputKeys:', inputKeys, 'inputPreview:', JSON.stringify(st.input ?? {}).substring(0, 200));
    _handleToolPart(part, turn);
  } else if (ptype === 'step-finish' && part.tokens) {
    turn.stepTokens = part.tokens;
  }
}

/**
 * Emit content/reasoning deltas. The part type comes from the tracked part
 * (delta events only carry `field` + `delta`).
 */
function _handlePartDelta(props, turn) {
  const partID = props?.partID;
  const delta = props?.delta;
  if (typeof delta !== 'string' || !delta) return;
  const part = partID ? turn.parts.get(partID) : null;
  const ptype = part?.type;
  if (ptype === 'reasoning') {
    emitJsonStringMarker('[THINKING_DELTA]', delta);
  } else if (ptype === 'text' || !ptype) {
    emitJsonStringMarker('[CONTENT_DELTA]', delta);
  }
}

/**
 * Map tool part state transitions onto marker-protocol tool_use / tool_result
 * `[MESSAGE]` blocks. A tool part is emitted once as `tool_use` and once as
 * `tool_result` (when it reaches a terminal state).
 */
export function _handleToolPart(part, turn) {
  const callID = part.callID || part.id;
  const name = part.tool || part.name || 'tool';
  const state = (part.state && typeof part.state === 'object') ? part.state : {};
  const status = typeof state.status === 'string' ? state.status : '';
  // opencode 的 tool part 生命周期里 state.input 有三种形态：
  //   pending       → ""            （空字符串，参数尚未解析）
  //   input.ended   → "<json 文本>" （仍是字符串）
  //   running 及之后 → { ... }       （真正的参数对象）
  //
  // 旧实现在第一次 part.updated 就 emit，并用 toolUseDone 永久锁死，于是前端
  // 拿到的永远是 input:{} —— Edits 面板从 input 里取不到 path（opencode 的
  // edit/write 用 `path` 字段），编辑列表在对话中和对话结束后都恒为空。
  //
  // 现在改为：参数就绪（对象且非空）后补发一次。宿主的 MessageMerger 按
  // content 块的 id 原地替换（getContentBlockKey → baseContent[idx] = 新块），
  // 所以补发不会产生重复的工具卡片。
  const rawInput = state.input;
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const inputJson = JSON.stringify(input);
  const emittedJson = turn.toolUseInput.get(callID);
  const inputReady = Object.keys(input).length > 0;
  logDebug('_handleToolPart:', 'name:', name, 'callID:', callID, 'status:', status,
    'inputKeys:', Object.keys(input), 'inputPreview:', inputJson.substring(0, 300),
    'toolUseDone:', turn.toolUseDone.has(callID), 'toolResultDone:', turn.toolResultDone.has(callID));

  if (emittedJson === undefined || (inputReady && emittedJson !== inputJson)) {
    turn.toolUseInput.set(callID, inputJson);
    turn.toolUseDone.add(callID);
    logDebug('emitToolUseMessage:', 'id:', callID, 'name:', name, 'status:', status, 'inputKeys:', Object.keys(input));
    emitToolUseMessage({ id: callID, name, input });
  }
  if ((status === 'completed' || status === 'error' || status === 'failed')
      && !turn.toolResultDone.has(callID)) {
    turn.toolResultDone.add(callID);
    const isError = status === 'error' || status === 'failed';
    const content = isError ? (state.error || '') : (state.output ?? '');
    logDebug('emitToolResultMessage:', 'toolUseId:', callID, 'isError:', isError,
      'contentLength:', typeof content === 'string' ? content.length : 0);
    emitToolResultMessage({ toolUseId: callID, content, isError });
  }
}

/**
 * 收尾兜底：用 turn.parts 中保存的最新 part 再走一次 _handleToolPart。
 * 万一某个 opencode 版本没有为 running 状态推送 message.part.updated，
 * 这里仍能把完整参数补发给前端（MessageMerger 按 id 原地替换，不重复）。
 */
function _reconcileToolParts(turn) {
  for (const part of turn.parts.values()) {
    if (!part || part.type !== 'tool') continue;
    _handleToolPart(part, turn);
  }
}

/**
 * Settle the active turn's promise (once).
 */
function _settleTurn(turn, { success, error }) {
  if (turn.settled) return;
  turn.settled = true;
  _reconcileToolParts(turn);
  turn.success = success;
  if (success) {
    turn.resolve({ ok: true });
  } else {
    const errMsg = error instanceof Error ? error.message
      : typeof error === 'string' ? error
      : typeof error?.message === 'string' ? error.message
      : typeof error?.data?.message === 'string' ? error.data.message
      : typeof error?.error === 'string' ? error.error
      : typeof error?.error?.message === 'string' ? error.error.message
      : JSON.stringify(error);
    turn.reject(new Error(errMsg));
  }
}

function _createTurn() {
  return {
    settled: false,
    success: false,
    promise: null,
    resolve: null,
    reject: null,
    aborted: false,
    parts: new Map(),
    toolUseDone: new Set(),
    // callID → 已发出的 tool_use input 的 JSON 快照。用于判断参数是否已
    // 从 pending 的空值晋级为真正的对象，从而决定是否需要补发。
    toolUseInput: new Map(),
    toolResultDone: new Set(),
    stepTokens: null,
    lastInfo: null,
  };
}

// =============================================================================
// Session helpers
// =============================================================================

/**
 * Resolve the session for a request: reuse the caller's id when it exists,
 * otherwise create a new session.
 * @param {string|null} requestedId
 * @param {string} directory
 * @returns {Promise<{ id: string, created: boolean }>}
 */
async function _resolveSession(requestedId, directory) {
  if (requestedId) {
    try {
      const existing = await sdk.getSession(requestedId, directory);
      if (existing?.id) {
        _sessions.set(existing.id, { directory, revert: existing.revert });
        return { id: existing.id, created: false };
      }
    } catch (err) {
      logDebug('getSession failed, will create:', err?.message || err);
    }
  }
  const created = await sdk.createSession('', directory);
  const id = created?.id;
  if (!id) {
    throw new Error(`opencode createSession returned no id: ${JSON.stringify(created)}`);
  }
  _sessions.set(id, { directory, revert: created.revert });
  return { id, created: true };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Send a message over the persistent opencode connection.
 *
 * @param {object} [params] - { sessionId?, message, model?, mode?, cwd?, attachments?, prompt? }
 */
export async function sendMessagePersistent(params = {}) {
  const safeParams = params || {};
  const startedAt = Date.now();

  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const rawMessage = typeof safeParams.message === 'string' ? safeParams.message : '';
  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  const agent = resolveAgentParam(safeParams);
  const model = resolveModelParam(safeParams.model);
  // 推理力度 → opencode model variant（docs/models#variants，按模型变化）。
  const variant = (typeof safeParams.reasoningEffort === 'string' && safeParams.reasoningEffort.trim())
    ? safeParams.reasoningEffort.trim()
    : undefined;

  // 斜杠命令经 safeParams.command 走 /session/{id}/command（见下方分支）。
  if (safeParams.prompt) {
    logDebug('prompt (legacy slash-command text) ignored:', safeParams.prompt);
  }

  // ── Resolve/create the session ──────────────────────────────────────────
  const { id: sessionId, created } = await _resolveSession(requestedId, directory);
  if (!created && requestedId !== sessionId) {
    // Caller passed an id we normalized; surface it so the host reuses ours.
    emitSessionId(sessionId);
  }

  // ── Materialize image attachments (temp files → file parts) ─────────────
  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(safeParams.attachments || []);
  } catch (err) {
    logDebug('materialize image attachments failed:', err?.message || err);
  }

  // opencode requires non-empty text even for image-only turns.
  let promptText = rawMessage.trim();
  if (!promptText && imagePaths.length > 0) {
    promptText = GROK_IMAGE_ONLY_FALLBACK_TEXT;
  }
  const imageParts = imagePaths.map((p) => ({ type: 'file', path: p, mediaType: 'image/png' }));

  // ── Register turn + emit stream-start markers ───────────────────────────
  beginStream(sessionId);
  emitSessionId(sessionId);

  const turn = _createTurn();
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });
  _activeTurns.set(sessionId, turn);

  logDebug(
    `send session=${sessionId} agent=${agent || '-'} model=${safeParams.model || '-'}`
    + ` command=${safeParams.command || '-'} images=${imagePaths.length} promptLen=${promptText.length}`
  );

  try {
    if (safeParams.command) {
      // opencode 原生斜杠命令：POST /session/{id}/command。回复经同一
      // SSE 事件流返回，turn/流式标记在上面已注册，与普通消息完全一致。
      // 注意：该端点 model 要求字符串（"provider/model"），与 promptAsync
      // 的 {providerID, modelID} 对象不同——传原始字符串。
      await sdk.sendCommand(sessionId, safeParams.command, {
        arguments: typeof safeParams.commandArguments === 'string' ? safeParams.commandArguments : '',
        model: typeof safeParams.model === 'string' && safeParams.model.trim() ? safeParams.model.trim() : undefined,
        agent,
        variant,
        directory,
        parts: imageParts,
      });
    } else {
      await sdk.promptAsync(sessionId, promptText, {
        model: model || undefined,
        agent,
        variant,
        directory,
        parts: imageParts,
      });
    }

    // Wait for session.idle / session.error / abort to settle the turn.
    await turn.promise;
  } catch (err) {
    if (turn.aborted) {
      // Graceful abort — clean "interrupted" result, no error toast.
      endStream({ sessionId });
      console.log(JSON.stringify({ success: false, error: 'User interrupted', elapsedMs: Date.now() - startedAt }));
      return;
    }
    endStream({ sessionId });
    const rawMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    let message = rawMsg;
    try {
      const parsed = JSON.parse(rawMsg);
      message = parsed?.message || parsed?.data?.message || parsed?.error?.message || rawMsg;
    } catch { /* not JSON, keep raw */ }
    console.log(JSON.stringify({ success: false, error: message, elapsedMs: Date.now() - startedAt }));
    emitSendError(message, 'OpenCode');
    return;
  } finally {
    _activeTurns.delete(sessionId);
    try {
      await cleanupMaterializedImagePaths(imagePaths);
    } catch (err) {
      logDebug('image cleanup failed:', err?.message || err);
    }
  }

  // ── Success: usage + full message + end markers ─────────────────────────
  const finalMessage = await _fetchFinalAssistantMessage(sessionId, directory);
  const usage = tokensToUsage(finalMessage?.tokens ?? turn.stepTokens);
  if (usage) emitUsage(usage);
  endStream({ sessionId, message: finalMessage || turn.lastInfo || { sessionID: sessionId } });
  console.log(JSON.stringify({ success: true, sessionId }));
}

/**
 * Run a shell command in the session context (opencode native `!` semantics).
 * The server executes the command, records it as a bash tool part, and streams
 * an AI reply over SSE — same lifecycle as sendMessagePersistent.
 *
 * @param {object} [params] - { sessionId?, command, model?, mode?, cwd? }
 */
export async function sendShellPersistent(params = {}) {
  const safeParams = params || {};
  const startedAt = Date.now();

  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const rawCommand = typeof safeParams.command === 'string' ? safeParams.command.trim() : '';
  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  const agent = resolveAgentParam(safeParams);
  const model = resolveModelParam(safeParams.model);

  if (!rawCommand) {
    console.log(JSON.stringify({ success: false, error: 'Empty shell command', elapsedMs: Date.now() - startedAt }));
    return;
  }

  // ── Resolve/create the session ──────────────────────────────────────────
  const { id: sessionId, created } = await _resolveSession(requestedId, directory);
  if (!created && requestedId !== sessionId) {
    emitSessionId(sessionId);
  }

  // ── Register turn + emit stream-start markers ───────────────────────────
  beginStream(sessionId);
  emitSessionId(sessionId);

  const turn = _createTurn();
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });
  _activeTurns.set(sessionId, turn);

  logDebug(`shell session=${sessionId} agent=${agent || '-'} cmdLen=${rawCommand.length}`);

  try {
    await sdk.promptAsync(sessionId, rawCommand, {
      model: model || undefined,
      agent,
      directory,
      parts: [],
    });

    // Wait for session.idle / session.error / abort to settle the turn.
    await turn.promise;
  } catch (err) {
    if (turn.aborted) {
      endStream({ sessionId });
      console.log(JSON.stringify({ success: false, error: 'User interrupted', elapsedMs: Date.now() - startedAt }));
      return;
    }
    endStream({ sessionId });
    const rawMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    let message = rawMsg;
    try {
      const parsed = JSON.parse(rawMsg);
      message = parsed?.message || parsed?.data?.message || parsed?.error?.message || rawMsg;
    } catch { /* not JSON, keep raw */ }
    console.log(JSON.stringify({ success: false, error: message, elapsedMs: Date.now() - startedAt }));
    emitSendError(message, 'OpenCode');
    return;
  } finally {
    _activeTurns.delete(sessionId);
  }

  // ── Success: usage + full message + end markers ─────────────────────────
  const finalMessage = await _fetchFinalAssistantMessage(sessionId, directory);
  const usage = tokensToUsage(finalMessage?.tokens ?? turn.stepTokens);
  if (usage) emitUsage(usage);
  endStream({ sessionId, message: finalMessage || turn.lastInfo || { sessionID: sessionId } });
  console.log(JSON.stringify({ success: true, sessionId }));
}

/**
 * Fetch the final assistant message for a completed turn (authoritative source
 * for tokens/parts in `[MESSAGE_END]`).
 */
async function _fetchFinalAssistantMessage(sessionId, directory) {
  try {
    const messages = await sdk.listMessages(sessionId, directory);
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        // session.messages returns { info, parts } entries; info is the
        // assistant-message object (id/role/tokens/modelID/providerID/sessionID).
        const info = m && typeof m.info === 'object' ? m.info : m;
        if (info?.role === 'assistant') return info;
      }
    }
  } catch (err) {
    logDebug('listMessages failed:', err?.message || err);
  }
  return null;
}

/**
 * Pre-warm: ensure `opencode serve` + SDK client + SSE subscription are ready
 * and resolve (or create) a session so the host can reuse its id.
 *
 * @param {object} [params] - { sessionId?, cwd? }
 */
export async function preconnectPersistent(params = {}) {
  const safeParams = params || {};
  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  const { id: sessionId } = await _resolveSession(requestedId, directory);
  emitSessionId(sessionId);
  console.log(`[STATUS] preconnect ready sessionId=${sessionId} server=${serveManager.getServerUrl() || '-'}`);
}

/**
 * Abort the active turn(s). Bypasses the command queue in daemon.js (runs
 * immediately, like the claude abort path). The opencode server settles the
 * turn with a `session.error`/`session.idle` which resolves the awaiting send.
 */
export async function abortCurrentTurn() {
  const sessions = [..._activeTurns.keys()];
  if (sessions.length === 0) return;
  for (const sessionId of sessions) {
    const turn = _activeTurns.get(sessionId);
    if (turn) turn.aborted = true;
    try {
      await sdk.abort(sessionId);
    } catch (err) {
      logDebug('abort failed:', err?.message || err);
    }
  }
}

/**
 * Best-effort context usage for a session. opencode does not expose a context
 * window the way claude does — surface token usage from the last assistant
 * message (used/max when known).
 *
 * @param {object} [params] - { sessionId?, cwd? }
 */
export async function getContextUsagePersistent(params = {}) {
  const safeParams = params || {};
  let usedTokens = null;
  let maxTokens = null;

  const sessionId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  if (sessionId) {
    const directory = selectWorkingDirectory(safeParams.cwd || null);
    try {
      const messages = await sdk.listMessages(sessionId, directory);
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i];
          const info = m && typeof m.info === 'object' ? m.info : m;
          if (info?.role === 'assistant' && info?.tokens) {
            usedTokens = (Number(info.tokens.input) || 0) + (Number(info.tokens.output) || 0);
            maxTokens = info.tokens.total ?? null;
            break;
          }
        }
      }
    } catch (err) {
      logDebug('getContextUsage listMessages failed:', err?.message || err);
    }
  }
  console.log(JSON.stringify({ success: true, data: { usedTokens, maxTokens, sessionId: sessionId || null } }));
}

/**
 * Shut down the persistent opencode runtime: abort any active turns, close the
 * SSE subscription and stop the serve process.
 */
export async function shutdownPersistentRuntimes() {
  // Abort active turns so awaiting sends settle (as "interrupted").
  for (const sessionId of [..._activeTurns.keys()]) {
    const turn = _activeTurns.get(sessionId);
    if (turn) turn.aborted = true;
    try {
      await sdk.abort(sessionId);
    } catch {
      // best-effort
    }
  }
  _activeTurns.clear();

  // Close every per-directory SSE subscription.
  for (const sub of _sseSubs.values()) {
    try {
      sub.controller.abort();
    } catch {
      // best-effort
    }
  }
  _sseSubs.clear();

  try {
    await serveManager.stop();
  } catch (err) {
    logDebug('serve stop failed:', err?.message || err);
  }
  _serveStarted = false;
  sdk.resetClient();
  _sessions.clear();
}
