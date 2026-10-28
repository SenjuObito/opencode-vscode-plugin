/**
 * Normalize the `revert.changed` host event.
 *
 * <p>The host publishes a named event: {@code payload = { state: {...} }} with
 * the tab and session on the envelope. The named-event dispatcher therefore
 * calls the handler as {@code (payload, envelope)} — not as the legacy
 * {@code (sessionId, stateJson)} pair. Older builds used both positional
 * shapes, so the parser accepts them all and returns one normalized value.</p>
 */
export interface RevertStateUpdate {
  hasRevert: boolean;
  messageId: string | null;
  sessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A payload body (as opposed to an envelope) carries the revert fields. */
function looksLikeState(value: Record<string, unknown>): boolean {
  return 'hasRevert' in value || 'messageId' in value || 'state' in value;
}

export function parseRevertStateEvent(args: unknown[]): RevertStateUpdate | null {
  const first = args[0];
  const second = args[1];
  let raw: unknown = null;
  let sessionId: string | null = null;

  if (isRecord(first) && isRecord(second)) {
    // Named event: [payload, envelope].
    sessionId = readString(second.sessionId) ?? readString(first.sessionId);
    raw = first.state ?? first.data ?? first;
  } else if (typeof first === 'string' && isRecord(second)) {
    if (looksLikeState(second)) {
      // Legacy positional event: [sessionId, stateObject].
      sessionId = readString(first);
      raw = second;
    } else {
      // Host sent the state as one JSON string plus the envelope:
      // [stateJson, envelope].
      sessionId = readString(second.sessionId);
      raw = first;
    }
  } else if (typeof first === 'string' && typeof second === 'string') {
    // Legacy positional event: [sessionId, stateJson].
    sessionId = readString(first);
    raw = second;
  } else {
    // One argument: a JSON string or the state object itself.
    raw = first;
  }

  let body: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body = isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  } else if (isRecord(raw)) {
    body = raw;
  }
  if (!body) return null;

  return {
    hasRevert: !!body.hasRevert,
    messageId: readString(body.messageId),
    sessionId: sessionId ?? readString(body.sessionId),
  };
}
