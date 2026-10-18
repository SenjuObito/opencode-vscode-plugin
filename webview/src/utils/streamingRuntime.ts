import type { MutableRefObject } from 'react';

/**
 * Per-session streaming runtime, exchanged on session/tab switch.
 *
 * ## Why this exists
 *
 * The streaming pipeline keeps its working set in single `useRef` holders
 * (`streamingContentRef`, `streamingMessageIndexRef`, `streamingTurnIdRef`, …).
 * That is correct for one conversation per webview, but this webview hosts N
 * sessions in the same JS context. When session B is streaming in the
 * background it only flips flags on `tabs[B]` — the refs above keep whatever
 * session A left there.
 *
 * Without an explicit exchange, activating B mid-turn makes B's deltas continue
 * from A's accumulator, which renders A's text into B (`patchAssistantForStreaming`
 * prefers the longer of `deltaContent` and `backendContent`), and the stale
 * message index can attach B's increment to an already-finished message.
 *
 * ## Design
 *
 * Rather than converting every ref into a `Map<sessionId, value>` — which would
 * rewrite hundreds of hot-path lines — the refs stay single-instance and are
 * saved/restored whole, like registers on a context switch.
 *
 * Deliberate omissions:
 *
 * - `streamingMessageIndexRef` is **never** restored. A background tab may have
 *   had messages appended while it was inactive, so the saved index is stale.
 *   Restoring `-1` makes `getOrCreateStreamingAssistantIndex` re-locate the live
 *   assistant via `findLastAssistantIndex`, which is always correct.
 * - `turnIdCounterRef` is **never** touched. It must stay monotonically
 *   increasing across every session so turnIds never collide (see
 *   `sessionTransition.ts` on why it is not reset either).
 */
export interface StreamingRuntimeRefs {
  isStreamingRef: MutableRefObject<boolean>;
  streamingContentRef: MutableRefObject<string>;
  streamingThinkingRef: MutableRefObject<string>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingTurnIdRef: MutableRefObject<number>;
  lastContentUpdateRef: MutableRefObject<number>;
  lastThinkingUpdateRef: MutableRefObject<number>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  trailingStructuralTextBoundaryRef?: MutableRefObject<{
    signature: string;
    textLength: number;
  } | null>;
}

export interface TrailingStructuralTextBoundary {
  signature: string;
  textLength: number;
}

export interface StreamingRuntimeSnapshot {
  isStreaming: boolean;
  content: string;
  thinking: string;
  useBackendStreamingRender: boolean;
  turnId: number;
  lastContentUpdate: number;
  lastThinkingUpdate: number;
  autoExpandedThinkingKeys: string[];
  trailingStructuralTextBoundary: TrailingStructuralTextBoundary | null;
  streamEndProcessedTurnId: number | null;
}

export const DEFAULT_STREAMING_RUNTIME: StreamingRuntimeSnapshot = {
  isStreaming: false,
  content: '',
  thinking: '',
  useBackendStreamingRender: false,
  turnId: -1,
  lastContentUpdate: 0,
  lastThinkingUpdate: 0,
  autoExpandedThinkingKeys: [],
  trailingStructuralTextBoundary: null,
  streamEndProcessedTurnId: null,
};

function readProcessedTurnId(): number | null {
  const value = window.__streamEndProcessedTurnId;
  return typeof value === 'number' ? value : null;
}

/** Snapshot the live refs so another session can take over the pipeline. */
export function captureStreamingRuntime(
  refs: StreamingRuntimeRefs,
): StreamingRuntimeSnapshot {
  return {
    isStreaming: refs.isStreamingRef.current,
    content: refs.streamingContentRef.current,
    thinking: refs.streamingThinkingRef.current,
    useBackendStreamingRender: refs.useBackendStreamingRenderRef.current,
    turnId: refs.streamingTurnIdRef.current,
    lastContentUpdate: refs.lastContentUpdateRef.current,
    lastThinkingUpdate: refs.lastThinkingUpdateRef.current,
    autoExpandedThinkingKeys: Array.from(refs.autoExpandedThinkingKeysRef.current),
    trailingStructuralTextBoundary:
      refs.trailingStructuralTextBoundaryRef?.current ?? null,
    streamEndProcessedTurnId: readProcessedTurnId(),
  };
}

/**
 * Load a snapshot back into the refs.
 *
 * `snapshot` is expected to come from `captureStreamingRuntime` or to be
 * `DEFAULT_STREAMING_RUNTIME`. A missing snapshot (a tab that never streamed)
 * must resolve to the default rather than being skipped — otherwise the
 * previous session's accumulator survives the switch.
 */
export function restoreStreamingRuntime(
  refs: StreamingRuntimeRefs,
  snapshot: StreamingRuntimeSnapshot,
): void {
  refs.isStreamingRef.current = snapshot.isStreaming;
  refs.streamingContentRef.current = snapshot.content;
  refs.streamingThinkingRef.current = snapshot.thinking;
  refs.useBackendStreamingRenderRef.current = snapshot.useBackendStreamingRender;
  refs.streamingTurnIdRef.current = snapshot.turnId;
  refs.lastContentUpdateRef.current = snapshot.lastContentUpdate;
  refs.lastThinkingUpdateRef.current = snapshot.lastThinkingUpdate;

  refs.autoExpandedThinkingKeysRef.current.clear();
  for (const key of snapshot.autoExpandedThinkingKeys) {
    refs.autoExpandedThinkingKeysRef.current.add(key);
  }

  if (refs.trailingStructuralTextBoundaryRef) {
    refs.trailingStructuralTextBoundaryRef.current =
      snapshot.trailingStructuralTextBoundary;
  }

  // Always re-locate; see the module docstring.
  refs.streamingMessageIndexRef.current = -1;

  window.__streamEndProcessedTurnId =
    snapshot.streamEndProcessedTurnId === null
      ? undefined
      : snapshot.streamEndProcessedTurnId;
}

/** Reset the live refs in place (used when a tab is closed). */
export function clearStreamingRuntime(refs: StreamingRuntimeRefs): void {
  restoreStreamingRuntime(refs, DEFAULT_STREAMING_RUNTIME);
}
