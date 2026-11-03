/**
 * resetTransientState.ts
 *
 * Clears the transient UI state (streaming refs, status flags, deferred frames)
 * that must not leak from the outgoing session into the incoming one.
 *
 * The transition guard itself is per tab and lives in `tabTransition.ts`; this
 * file only owns the reset.
 *
 * <p>The "waiting for history" indicator is NOT transient window state: it
 * belongs to the tab that asked for the load and lives on its record, so a
 * reset of any tab leaves it alone.</p>
 */

import type { MutableRefObject } from 'react';
import { cardDebugLog } from '../../utils/bridge';

export interface ResetTransientUiStateOptions {
  clearToasts: () => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;

  // Streaming refs
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingContentRef: MutableRefObject<string>;
  streamingThinkingRef: MutableRefObject<string>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  contentUpdateTimeoutRef: MutableRefObject<number | null>;
  thinkingUpdateTimeoutRef: MutableRefObject<number | null>;

  // Turn tracking ref (for streaming assistant isolation)
  streamingTurnIdRef: MutableRefObject<number>;

  /**
   * Called immediately BEFORE the streaming refs below are wiped.
   *
   * The streaming runtime belongs to the tab, so wiping the refs only clears
   * the tab that is on screen; a background tab keeps its own accumulator.
   */
  onBeforeResetTransientState?: () => void;
}

/**
 * Clear all transient UI state (streaming refs + React state flags).
 * Called on clearMessages and exposed as window.__resetTransientUiState so
 * useSessionTransition can invoke it synchronously during session transitions.
 */
export const buildResetTransientUiState = (opts: ResetTransientUiStateOptions) => {
  return () => {
    opts.clearToasts();
    opts.setStatus('');
    opts.setLoading(false);
    opts.setLoadingStartTime(null);
    opts.setIsThinking(false);
    opts.setStreamingActive(false);
    // Archive the outgoing session's live streaming runtime before wiping it.
    // Must run BEFORE the ref resets below: `loadHistorySession` leaves the
    // previous turn running in the background, and that turn still needs its
    // accumulator / turnId when the user comes back to it.
    try {
      opts.onBeforeResetTransientState?.();
    } catch (error) {
      cardDebugLog('[resetTransientUiState] archive streaming runtime failed:', error);
    }
    opts.isStreamingRef.current = false;
    opts.useBackendStreamingRenderRef.current = false;
    opts.streamingMessageIndexRef.current = -1;
    opts.streamingContentRef.current = '';
    opts.streamingThinkingRef.current = '';
    opts.autoExpandedThinkingKeysRef.current.clear();
    // Reset active turn ID to prevent stale streaming assistant recovery.
    // NOTE: turnIdCounterRef is intentionally NOT reset — it must stay monotonically
    // increasing across sessions so that stale messages from an old session can never
    // collide with a new session's turn IDs (and React keys like "turn-N" stay unique).
    opts.streamingTurnIdRef.current = -1;
    // Clear stream-end idempotency guard to avoid stale state across sessions.
    window.__streamEndProcessedTurnId = undefined;
    if (opts.contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.contentUpdateTimeoutRef.current);
      opts.contentUpdateTimeoutRef.current = null;
    }
    if (opts.thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.thinkingUpdateTimeoutRef.current);
      opts.thinkingUpdateTimeoutRef.current = null;
    }
    // Cancel any updateMessages deferred during the outgoing session's streaming.
    // beginSessionTransition reaches this via window.__resetTransientUiState
    // (not clearMessages, which cancels them itself), so without this a buffered
    // frame would later fire its deferred processUpdateMessages — with
    // isStreamingRef already cleared here — and resurrect the cleared messages.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
  };
};
