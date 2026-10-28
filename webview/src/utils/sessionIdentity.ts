/**
 * sessionIdentity.ts
 *
 * The single place that decides "which session does this incoming write belong
 * to?".
 *
 * ## Why this module exists
 *
 * Before, every bridge callback did its own version of:
 *
 *     const effectiveSessionId = targetSessionId || currentSessionIdRef.current;
 *
 * That is a *guess*: an empty id was read as "the session currently on screen".
 * With one session open it was always right, so it never showed up as a bug.
 * With several, it is wrong exactly when it matters — a delta, a terminal
 * signal, or a prompt from session B lands in session A. Worse, when the owning
 * session was not the active one, later layers filtered the write out entirely,
 * so the same guess also produced *silent loss*.
 *
 * ## The rule
 *
 * An empty id is **unattributable**, never "the active session". Unattributable
 * writes are dropped and counted. Dropping is the only behaviour that can
 * neither mis-route nor corrupt; the counter turns what used to be a silent
 * no-op into something visible in the console.
 *
 * The host enforces the same rule one layer up (see
 * `SessionCallbackAdapter#hasIdentity`), so by the time a write reaches here an
 * empty id already means "something upstream failed to attach identity" — a
 * defect worth surfacing, not worth guessing around.
 */

import { cardDebugLog } from './bridge';

/** How many unattributable writes have been dropped, by kind. */
const droppedByKind = new Map<string, number>();

/**
 * Log the first drop of each kind, then every 50th — enough to notice, not spam.
 *
 * 必须走 cardDebugLog：生产构建把 console.warn 整体置为 noop（main.tsx），
 * 而「丢包计数」是排障时唯一能看到这类缺陷的信号——2026-10-17 排查
 * 「历史会话加载空白」时，正因为这条警告被静默，现场才无从还原。
 */
function noteDrop(kind: string): void {
  const next = (droppedByKind.get(kind) ?? 0) + 1;
  droppedByKind.set(kind, next);
  if (next === 1 || next % 50 === 0) {
    cardDebugLog(
      `[sessionIdentity] dropped ${next} unattributable "${kind}" write(s): ` +
      'no session id on the wire, and guessing the active session is what caused cross-session leakage. ' +
      'This is an upstream defect — the host should have attached identity or dropped it itself.'
    );
  }
}

/** Test/telemetry seam: total unattributable writes dropped for a kind. */
export function droppedCount(kind: string): number {
  return droppedByKind.get(kind) ?? 0;
}

/** Test seam only. */
export function resetDroppedCounts(): void {
  droppedByKind.clear();
}

/**
 * Normalize an id that arrived over the bridge.
 *
 * The host serializes `null` arguments as `''` (see
 * `WebviewEventQueue#sanitizeArgForJsLiteral`), so `''`, `null` and
 * `'undefined'` all mean the same thing: no identity.
 */
function normalize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * Resolve the session a bridge write belongs to.
 *
 * @param targetSessionId the id carried on the wire
 * @param kind            short label used for the drop counter / warning
 * @returns the session id, or `null` when the write carries no identity
 */
export function resolveSessionId(
  targetSessionId: unknown,
  kind: string,
): string | null {
  const resolved = normalize(targetSessionId);
  if (resolved === null) {
    noteDrop(kind);
    return null;
  }
  return resolved;
}

/**
 * Same as {@link resolveSessionId} but for the two-arg bridge convention where
 * callers may pass `(sessionId, payload)` or just `(payload)`.
 *
 * Returns `null` for *identity* when unattributable — note this is distinct from
 * "the payload was passed as the first argument", which is a legacy calling
 * convention and still resolves via the fallback below.
 */
export function resolveSessionIdWithLegacyFallback(
  arg0: unknown,
  arg1: unknown,
  kind: string,
): { sessionId: string | null; payload: unknown } {
  if (typeof arg1 !== 'undefined') {
    return { sessionId: resolveSessionId(arg0, kind), payload: arg1 };
  }
  return { sessionId: resolveSessionId(null, kind), payload: arg0 };
}
