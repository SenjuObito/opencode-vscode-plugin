/**
 * sessionTransition.ts
 *
 * Helpers for session transition guard management and transient UI state reset.
 * These functions encapsulate the logic that coordinates the React state setters
 * and streaming refs when a new session is initiated.
 */

import type { MutableRefObject } from 'react';
import { cardDebugLog } from '../../utils/bridge';
import { forceWebviewRepaint } from '../../utils/forceWebviewRepaint';

export interface ResetTransientUiStateOptions {
  clearToasts: () => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompacting?: React.Dispatch<React.SetStateAction<boolean>>;
  setCompactingStartTime?: React.Dispatch<React.SetStateAction<number | null>>;

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
   * Leaving a session does not mean the session stopped running — a background
   * turn keeps pushing deltas into its own tab. Archiving the live streaming
   * runtime here is what lets the user switch back and continue seamlessly
   * instead of inheriting an empty accumulator that would render the *previous*
   * session's text into this one.
   */
  onBeforeResetTransientState?: () => void;
}

/**
 * Clear all transient UI state (streaming refs + React state flags).
 * Called on clearMessages and exposed as window.__resetTransientUiState so
 * useSessionTransition can invoke it synchronously during session transitions.
 *
 * @param opts.skipSessionLoading - When true, do NOT reset sessionLoading.
 *   Used by beginSessionTransition which sets sessionLoading=true immediately
 *   after; resetting it here would cause a transient false→true flicker because
 *   React 18 batches the reset+set into one render with sessionLoading=false.
 */
export const buildResetTransientUiState = (opts: ResetTransientUiStateOptions) => {
  return (skipSessionLoading?: boolean) => {
    const shouldSkipSS = skipSessionLoading || window.__sessionTransitioning;
    cardDebugLog('[resetTransientUiState] skipSessionLoading:', skipSessionLoading, 'transitioning:', window.__sessionTransitioning, '→ skip:', shouldSkipSS);
    cardDebugLog('[resetTransientUiState] BEFORE: sessionLoading will', shouldSkipSS ? 'BE KEPT' : 'be SET TO false');
    opts.clearToasts();
    opts.setStatus('');
    opts.setLoading(false);
    opts.setLoadingStartTime(null);
    opts.setIsThinking(false);
    opts.setStreamingActive(false);
    opts.setIsCompacting?.(false);
    opts.setCompactingStartTime?.(null);
    const shouldSkip = skipSessionLoading || window.__sessionTransitioning;
    if (!shouldSkip) {
      cardDebugLog('[resetTransientUiState] EXECUTING: setSessionLoading(false)');
      opts.setSessionLoading(false);
    } else {
      cardDebugLog('[resetTransientUiState] SKIPPED: setSessionLoading not called');
    }
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
    // Clear JCEF native-rendering ghosting left behind by the outgoing session's
    // overlays and input-box content after the transition unmounts/reflows them.
    // Windowed JCEF only: on OSR the content swap is published through the Java
    // surface fence once the new transcript commits.
    forceWebviewRepaint('session-transition');
  };
};

/**
 * Release the session transition guard flags set by beginSessionTransition
 * (useSessionManagement).
 *
 * Note: unlike cc-gui this project does not buffer `updateMessages` while the
 * guard is active — `messageCallbacks.updateMessages` *drops* payloads from
 * non-target sessions and lets the target through (messageCallbacks.ts:589-600).
 * So there is nothing to flush here.
 */
export const releaseSessionTransition = (): void => {
  if (window.__sessionTransitioning) {
    window.__sessionTransitioning = false;
  }
  window.__sessionTransitionToken = null;
  window.__sessionTransitionTargetSessionId = null;
};
