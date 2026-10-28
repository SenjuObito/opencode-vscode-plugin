/**
 * The shape of a host event on the webview side.
 *
 * <p>A named event carries its identity in the envelope and its content in the
 * payload; the handler reads fields by name. Adding a field to an event
 * therefore never changes a handler's signature.</p>
 */
export interface HostEventPayload {
  [field: string]: unknown;
}

export interface HostEventEnvelope {
  v?: number;
  type?: string;
  tabId?: string;
  sessionId?: string;
  turnId?: number;
  seq?: number;
  epoch?: number;
  payload?: HostEventPayload;
}

/** The session a named event belongs to, or {@code null}. */
export function eventSessionId(envelope?: HostEventEnvelope | null): string | null {
  return envelope?.sessionId ?? null;
}

/** The tab a named event belongs to, or {@code null}. */
export function eventTabId(envelope?: HostEventEnvelope | null): string | null {
  return envelope?.tabId ?? null;
}

/**
 * Read a JSON field of a named event.
 *
 * <p>The host sends the parsed document, but a field that travelled as a JSON
 * string (some daemon payloads do) is accepted as well — the handler must not
 * care how the value was encoded.</p>
 */
export function readJson<T = unknown>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}
