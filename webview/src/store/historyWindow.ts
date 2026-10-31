/**
 * The host's paging window for one tab's transcript (`history.window`).
 *
 * <p>Only the host knows where the engine's cursor is and how many turns the
 * whole session has; the webview renders that snapshot. Nothing here is
 * derived from the loaded messages, because the loaded page can contain zero
 * user turns — which is exactly the case that used to hide every "load
 * earlier" affordance.</p>
 */
export interface HistoryWindowState {
  sessionId: string | null;
  hasEarlier: boolean;
  loadedCount: number;
  pageSize: number;
  loadedTurns: number;
  /** Turns in the whole session; null while the count is still unknown. */
  totalTurns: number | null;
  loading: boolean;
}

const EMPTY_HISTORY_WINDOW: HistoryWindowState = {
  sessionId: null,
  hasEarlier: false,
  loadedCount: 0,
  pageSize: 200,
  loadedTurns: 0,
  totalTurns: null,
  loading: false,
};

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Parse a `history.window` payload; null when it is not shaped like one. */
export function parseHistoryWindow(payload: unknown): HistoryWindowState | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null;
  return {
    sessionId,
    hasEarlier: raw.hasEarlier === true,
    loadedCount: readNumber(raw.loadedCount, 0),
    pageSize: readNumber(raw.pageSize, EMPTY_HISTORY_WINDOW.pageSize),
    loadedTurns: readNumber(raw.loadedTurns, 0),
    totalTurns: typeof raw.totalTurns === 'number' && Number.isFinite(raw.totalTurns)
      ? Math.max(0, raw.totalTurns)
      : null,
    loading: raw.loading === true,
  };
}
