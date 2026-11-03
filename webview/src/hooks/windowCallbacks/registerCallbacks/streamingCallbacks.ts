/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import { startTransition } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { parseSequence } from '../parseSequence';
import { getStreamEndHandlingMode } from '../messageSync';
import { reconstructTurnMetadata } from '../../../utils/turnMetadataReconstruction';
import { isTabTransitioning, activeTabId } from '../tabTransition';
import { registerHostEvents } from '../../../utils/hostEventRegistry';
import { parseSubagentStatusEvent, parseTaskNotification } from '../../../utils/taskEventParser';
import { onTerminalErrorFromHost } from '../../../components/StatusNoticeBar';
import type { HostEventEnvelope } from '../../../utils/hostEventTypes';
import {
  appendDeltaToTab,
  applySnapshotToTab,
  applyTailToTab,
  isActiveTabEvent,
  parseEventJson,
  updateBackgroundTab,
} from '../../../utils/tabEventRouting';
import { resolveSessionId } from '../../../utils/sessionIdentity';
import { getTabStore } from '../../../store/tabStore';

/**
 * Pour every tool_use_id carried by tool_result blocks inside one message's raw
 * into the supplied accumulator.
 *
 * Writing into a caller-provided Set (instead of returning a fresh one) lets
 * {@link collectUnresolvedToolUseIds} fold every message into a single pass
 * without per-message intermediate allocations. A no-op when the message has
 * no usable raw or no tool_result blocks.
 */
const harvestToolResultIdsInto = (
  message: ClaudeMessage | undefined,
  target: Set<string>,
): void => {
  if (!message?.raw) return;
  const rawObj = typeof message.raw === 'string' ? JSON.parse(message.raw) : message.raw;
  const content = rawObj?.content ?? rawObj?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      target.add(block.tool_use_id);
    }
  }
};

/**
 * Scans assistant messages containing tool_use blocks and returns IDs that have
 * no matching tool_result anywhere in the conversation.
 *
 * scope: 'lastTurn'  — only inspect the most recent assistant tool_use group and
 *                       every consecutive user message trailing it (default;
 *                       used by onPermissionDenied + onStreamEnd, where only the
 *                       active turn can have stragglers). The trailing sweep
 *                       stops at the first non-user message so results from a
 *                       later turn never leak into this turn's resolution set.
 * scope: 'all'       — collect every tool_use ID across the whole message list
 *                       and check against every tool_result block anywhere.
 *                       Required by historyLoadComplete because a replayed
 *                       Codex session may contain multiple aborted turns whose
 *                       missing results would otherwise be invisible to the
 *                       lastTurn heuristic.
 *
 * Without this, tool blocks like BashToolGroupBlock keep rendering pending
 * spinners forever because parseBashItem treats `result == null` as "still
 * running".
 */
export function collectUnresolvedToolUseIds(
  messages: ClaudeMessage[],
  scope: 'lastTurn' | 'all' = 'lastTurn',
): string[] {
  const idsToAdd: string[] = [];
  try {
    if (scope === 'all') {
      // Pass 1: gather every tool_result id present anywhere in the conversation.
      const resolvedIds = new Set<string>();
      for (const msg of messages) {
        harvestToolResultIdsInto(msg, resolvedIds);
      }
      // Pass 2: flag every assistant tool_use without a matching result.
      for (const msg of messages) {
        if (msg.type !== 'assistant' || !msg.raw) continue;
        const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
        const content = rawObj?.content ?? rawObj?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<{ type?: string; id?: string }>) {
          if (block?.type === 'tool_use' && block.id
              && !resolvedIds.has(block.id)
              && !window.__deniedToolIds?.has(block.id)) {
            idsToAdd.push(block.id);
          }
        }
      }
      return idsToAdd;
    }

    // scope === 'lastTurn'
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant' || !msg.raw) continue;
      const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
      const content = rawObj.content || rawObj.message?.content;
      if (!Array.isArray(content)) continue;

      const toolUses = content.filter(
        (block: { type?: string; id?: string }) =>
          block.type === 'tool_use' && block.id,
      ) as Array<{ type: string; id: string; name?: string }>;
      if (toolUses.length === 0) continue;

      // Collect tool_result ids from EVERY user message trailing this assistant,
      // not just messages[i + 1]. The backend (ClaudeMessageHandler.handleToolResult)
      // emits one user message per tool_result, so N parallel tool_use fan out into
      // N consecutive user messages. Stopping at the first result message would
      // strand the remaining tool_use ids and mark them as interrupted (red badge)
      // even though their results are present further down the list. The sweep
      // halts at the first non-user message (e.g. the next assistant) so results
      // belonging to a later turn never leak into this turn's resolution set.
      const existingResultIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const follower = messages[j];
        if (follower?.type !== 'user') break;
        harvestToolResultIdsInto(follower, existingResultIds);
      }

      for (const tu of toolUses) {
        if (!existingResultIds.has(tu.id) && !window.__deniedToolIds?.has(tu.id)) {
          idsToAdd.push(tu.id);
        }
      }
      break;
    }
  } catch (e) {
    console.error('[Frontend] Error in collectUnresolvedToolUseIds:', e);
  }
  return idsToAdd;
}

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    patchAssistantForStreaming,
  } = options;

  /**
   * The transition guard belongs to the tab that is switching.
   *
   * <p>This webview renders one tab at a time (the host projects only the
   * active tab's output), so "the tab that is switching" is the active tab.
   * A background tab starting a load must therefore not silence the
   * foreground tab's stream — the window-wide flag this replaced did
   * exactly that.</p>
   */
  const isActiveTabTransitioning = (): boolean => isTabTransitioning(activeTabId());

  // ── Stream stall watchdog ──
  // Tracks the last time we received any streaming activity (delta or
  // updateMessages during streaming).  A periodic check auto-recovers
  // if the backend's onStreamEnd signal was silently lost.
  // Exposed on window so messageCallbacks can also bump this on updateMessages.
  //
  // The interval handle is stored on `window` so that if registerStreamingCallbacks
  // is called again (e.g., HMR, parent re-render), the previous interval is
  // cleared first — preventing multiple watchdogs from running simultaneously.
  if (window.__stallWatchdogInterval != null) {
    clearInterval(window.__stallWatchdogInterval);
    window.__stallWatchdogInterval = null;
  }
  window.__lastStreamActivityAt = 0;

  const clearStallWatchdog = () => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  };

  const startStallWatchdog = () => {
    // Intentionally no-op: do not auto-interrupt streaming turns on inactivity,
    // as long-running commands, large codebase indexing, or deep reasoning may take arbitrarily long.
    clearStallWatchdog();
    window.__lastStreamActivityAt = Date.now();
  };

  window.onStreamStart = (mode?: string | boolean) => {
    if (isActiveTabTransitioning()) return;
    const isReplayStart = mode === 'replay' || mode === true;
    // Clear any stale pending updateMessages from previous turn.
    // This prevents onStreamEnd from using outdated snapshot data.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Explicit null in case the rAF already executed (clearing pendingUpdateRaf)
    // but __pendingUpdateJson was not yet cleared by the rAF callback.
    window.__pendingUpdateJson = null;
    // Clear the previous stream-ended marker when a new turn starts
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // Clear idempotency guard for the new turn
    window.__streamEndProcessedTurnId = undefined;
    // Record turn start time for duration calculation in onStreamEnd
    window.__turnStartedAt = Date.now();
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    getTabStore().mutateActiveTranscript((transcript) => {
      const index = transcript.beginAssistant(streamingTurnIdRef.current, isReplayStart);
      if (index >= 0) streamingMessageIndexRef.current = index;
    });
  };

  // rAF-scheduled streaming update: frame-aligned, avoids setTimeout jank.
  // Factory that creates a throttled scheduler bound to a specific timeoutRef +
  // lastUpdateRef pair.  patchAssistantForStreaming reads streamingContentRef /
  // streamingThinkingRef from the hook closure, so the factory only needs to
  // know which ref pair to guard against double-scheduling.
  const createStreamingRafScheduler = (
    timeoutRef: React.MutableRefObject<number | null>,
    lastUpdateRef: React.MutableRefObject<number>,
  ) => {
    const scheduleRaf = (): void => {
      if (timeoutRef.current != null) return;
      timeoutRef.current = requestAnimationFrame(() => {
        timeoutRef.current = null;
        // Guard: the turn may have ended (or been interrupted by the user)
        // while this frame was queued. patchAssistantForStreaming reads the
        // delta buffers unconditionally and force-sets isStreaming: true, so a
        // stale frame would flush buffered content into whichever assistant
        // message streamingMessageIndexRef still points at — leaking one turn's
        // text into another's bubble. Bail out; the authoritative onStreamEnd
        // updater owns the final write for that message.
        if (!isStreamingRef.current) return;
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;
        if (elapsed < THROTTLE_INTERVAL) {
          scheduleRaf(); // too soon — wait for next frame
          return;
        }
        lastUpdateRef.current = now;
        startTransition(() => {
          getTabStore().mutateActiveTranscript((transcript) => {
            const index = transcript.patchAssistant(streamingTurnIdRef.current, (message) => (
              patchAssistantForStreaming({ ...message, isStreaming: true })
            ));
            if (index >= 0) streamingMessageIndexRef.current = index;
          });
        });
      });
    };
    return scheduleRaf;
  };

  const scheduleContentRaf = createStreamingRafScheduler(contentUpdateTimeoutRef, lastContentUpdateRef);
  const scheduleThinkingRaf = createStreamingRafScheduler(thinkingUpdateTimeoutRef, lastThinkingUpdateRef);

  /**
   * Recover streaming state when stream content arrives but we believe we are
   * idle.  `onStreamStart` is the authoritative start signal, but it can be
   * dropped (delivered before `window.onStreamStart` was registered, or lost on
   * a transient channel).  Because the coalescer also pushes message snapshots
   * via `updateMessages` independent of `streamingActive`, content would still
   * render while `streamingActive` stayed false — so the host looked busy but
   * the StatusPanel (and `finalizeTodosForSettledTurn`) behaved as if the turn
   * had settled, wrongly flipping `in_progress` todos to `completed`.  An
   * incoming content/thinking delta is undeniable proof the backend is
   * mid-stream, so we recover the streaming state here.
   */
  const ensureStreamingActive = (): void => {
    if (isStreamingRef.current) return;
    isStreamingRef.current = true;
    setStreamingActive(true);
    startStallWatchdog();
  };

  window.onContentDelta = (delta: string) => {
    if (isActiveTabTransitioning()) return;
    ensureStreamingActive();
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    scheduleContentRaf();
  };

  window.onThinkingDelta = (delta: string) => {
    if (isActiveTabTransitioning()) return;
    ensureStreamingActive();
    window.__lastStreamActivityAt = Date.now();
    streamingThinkingRef.current += delta;
    scheduleThinkingRaf();
  };

  // Mark any tool_use block that never received a tool_result as denied, so its
  // card stops spinning. Runs against the current message list; a no-op on a
  // fully-resolved turn. Used both on normal stream end and on the turn-ended-
  // without-a-stream paths (errors, non-streaming turns) so a failed turn never
  // leaves the agent's last tool hanging forever.
  const finalizeUnresolvedToolUses = () => {
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    try {
      const transcript = getTabStore().getActiveTab().transcript;
      const interruptedIds = collectUnresolvedToolUseIds(transcript.getSnapshot());
      if (interruptedIds.length === 0) return;
      const denied = window.__deniedToolIds!;
      for (const id of interruptedIds) denied.add(id);
      // A fresh snapshot reference re-renders the now-denied tool cards.
      getTabStore().mutateActiveTranscript((current) => current.touch());
    } catch (error) {
      console.error('[Frontend] Failed to finalize unresolved tool ids:', error);
    }
  };

  window.onStreamEnd = (sequence?: string | number) => {
    if (isActiveTabTransitioning()) return;

    // Idempotency guard: dual-path delivery (primary via flush callback +
    // fallback via Alarm) may send onStreamEnd twice for the same turn.
    // Only the first arrival takes effect; the second is a no-op.
    //
    // After the first onStreamEnd processes, streamingTurnIdRef is cleared to -1
    // and isStreamingRef is set to false. The second arrival sees these cleared
    // refs and should bail out. We check both conditions:
    // 1. If the current turn ID was already processed (before refs were cleared)
    // 2. If streaming is already inactive (refs were already cleared by first call)
    const currentTurnId = streamingTurnIdRef.current;
    const handlingMode = getStreamEndHandlingMode(
      options.currentProviderRef.current,
      isStreamingRef.current,
      currentTurnId,
    );
    if (currentTurnId > 0 && window.__streamEndProcessedTurnId === currentTurnId) {
      return;
    }
    if (handlingMode === 'skip') {
      finalizeUnresolvedToolUses();
      return;
    }

    clearStallWatchdog();
    const parsedSequence = parseSequence(sequence);
    // Only update minAcceptedUpdateSequence for valid positive sequences.
    // The fallback path sends sequence=-1 which means "no sequence info" —
    // it should not participate in sequence tracking.
    if (parsedSequence != null && parsedSequence >= 0) {
      window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, parsedSequence);
    }
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    if (handlingMode === 'minimal') {
      if (typeof window.__cancelPendingUpdateMessages === 'function') {
        window.__cancelPendingUpdateMessages();
      }
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      window.__streamEndProcessedTurnId = currentTurnId > 0 ? currentTurnId : undefined;
      return;
    }

    // FIX: Extract backend final snapshot from pending updateMessages BEFORE cancelling rAF.
    // The backend's final flush contains the authoritative message state (complete raw blocks).
    // If onStreamEnd cancels the rAF without processing this snapshot, the final message may
    // show incomplete content (e.g., last delta missing) or duplicated content in raw blocks.
    //
    // FIX: Also preserve tool_result user messages from the pending snapshot.
    // Previously only the assistant message was extracted; tool_result user messages were
    // silently dropped when the pending rAF was cancelled.  This caused tool cards to
    // remain stuck in "pending" state (spinner) even though the tool had completed.
    let backendSnapshotContent: string | undefined;
    let backendSnapshotRaw: ClaudeRawMessage | string | undefined = undefined;
    const pendingToolResultMsgs: Array<{ content: string; raw: Record<string, unknown> }> = [];
    if (typeof window.__pendingUpdateJson === 'string' && window.__pendingUpdateJson.length > 0) {
      try {
        const parsed = JSON.parse(window.__pendingUpdateJson) as Array<Record<string, unknown>>;
        for (let i = parsed.length - 1; i >= 0; i--) {
          if (parsed[i]?.type === 'assistant') {
            const rawContent = parsed[i].content;
            const content = typeof rawContent === 'string' ? rawContent : '';
            if (content) {
              backendSnapshotContent = content;
              const rawVal = parsed[i].raw;
              if (rawVal != null && (typeof rawVal === 'object' || typeof rawVal === 'string')) {
                backendSnapshotRaw = rawVal as ClaudeRawMessage | string;
              }
            }
            break;
          }
        }
        // Collect tool_result user messages from the pending snapshot so that
        // completed tool calls are not lost when the rAF is cancelled below.
        for (let i = 0; i < parsed.length; i++) {
          const msg = parsed[i];
          if (msg?.type === 'user' && typeof msg.content === 'string' && msg.content.trim() === '[tool_result]') {
            const raw = msg.raw as Record<string, unknown> | undefined;
            if (raw != null && typeof raw === 'object') {
              pendingToolResultMsgs.push({ content: '[tool_result]', raw });
            }
          }
        }
      } catch (error) {
        // __pendingUpdateJson is produced internally by the bridge; a parse failure
        // indicates an upstream contract violation worth surfacing for diagnosis.
        console.warn('[Frontend] Failed to parse __pendingUpdateJson on stream end:', error);
      }
    }

    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

    // Clear pending rAF callbacks — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }

    // Snapshot the keys to collapse before the buffers are cleared.
    const keysToCollapse = new Set(autoExpandedThinkingKeysRef.current);

    // Snapshot the turn start time before the ref is reset.
    const turnStartedAt = window.__turnStartedAt;
    window.__turnStartedAt = undefined;
    // One timestamp for the whole settle: the transcript receives these values
    // instead of reading the clock itself.
    const streamEndedAt = Date.now();
    const durationMs = (typeof turnStartedAt === 'number' && turnStartedAt > 0)
      ? streamEndedAt - turnStartedAt
      : undefined;
    const toolResultTimestamp = new Date(streamEndedAt).toISOString();

    // Snapshot streaming state BEFORE clearing refs - used for post-stream merge guard
    const endedStreamingTurnId = streamingTurnIdRef.current;

    // Initialize denied tool ids set if not exists
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    // FIX: Prioritize streaming content over backend snapshot to prevent digit loss
    // Streaming content has all the latest deltas (including the final one just flushed).
    // Backend snapshot might be from an earlier coalescer push and may be incomplete.
    const endedStreamingContent = streamingContentRef.current || backendSnapshotContent || '';
    const endedBackendRaw = backendSnapshotRaw;

    // Clear the streaming refs before the transcript write: the values the
    // settle needs were snapshotted above, and a deferred updateMessages that
    // runs afterwards must see this tab as no longer streaming.
    //
    // Streaming state refs (isStreaming flag)
    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;

    // Index refs (message position tracking)
    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;

    // Content buffer refs
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    autoExpandedThinkingKeysRef.current.clear();

    // Mark that streaming just ended - used by mergeConsecutiveAssistantMessages to
    // distinguish recently-ended streaming messages from true history messages.
    window.__lastStreamEndedTurnId = endedStreamingTurnId;
    window.__lastStreamEndedAt = Date.now();

    // Flush final content and finalize the streaming message. The transcript
    // owns the turn: it settles the pending assistant with whatever the deltas
    // buffered (never a shorter backend copy), keeps the backend's structural
    // blocks, and folds in tool results the cancelled rAF would have carried.
    const transcript = getTabStore().getActiveTab().transcript;
    getTabStore().mutateActiveTranscript((current) => {
      current.finalizeStreamingTurn(
        {
          turnId: endedStreamingTurnId,
          content: endedStreamingContent,
          backendRaw: endedBackendRaw,
          durationMs,
          pendingToolResults: pendingToolResultMsgs,
          toolResultTimestamp,
        },
        (messages) => reconstructTurnMetadata(messages, { skipTrailingTurn: false }),
      );
    });

    // Interrupted tools are read from the settled transcript, so a card whose
    // tool_use never received a result stops spinning instead of outliving the
    // turn. The denied set is idempotent.
    try {
      const interruptedIds = collectUnresolvedToolUseIds(transcript.getSnapshot());
      const deniedToolIds = window.__deniedToolIds!;
      for (const id of interruptedIds) deniedToolIds.add(id);
    } catch (error) {
      console.error('[Frontend] Failed to collect interrupted tool ids:', error);
    }

    // Collapse auto-expanded thinking blocks using the pre-clear snapshot
    if (setExpandedThinking && keysToCollapse.size > 0) {
      setExpandedThinking((prev) => {
        const next = { ...prev };
        keysToCollapse.forEach((key) => {
          next[key] = false;
        });
        return next;
      });
    }

    // React state (not ref) — the transcript write above already happened, so
    // the indicator and the list settle in the same commit.
    setStreamingActive(false);

    // FIX: onStreamEnd is the authoritative signal that streaming has ended.
    // Reset loading state here to prevent race conditions where showLoading("false")
    // arrives before onStreamEnd and gets ignored by the isStreamingRef guard,
    // while the flush callback's showLoading("false") may be delayed or lost
    // (e.g., due to slow message serialization or multi-hop async chains).
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);

    // Mark this turn as processed — idempotency guard for dual-path delivery
    window.__streamEndProcessedTurnId = endedStreamingTurnId;
  };

  // Streaming heartbeat — lightweight signal from backend during tool execution
  // phases where no content deltas arrive.  Keeps the stall watchdog alive.
  window.onStreamingHeartbeat = () => {
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
  };

  // Permission denied callback — kept as a no-op for backward compatibility.
  //
  // The host always calls onStreamEnd() immediately after this in the same
  // dispatch block. onStreamEnd performs the interrupted-tool scan against the
  // settled transcript, which supersedes anything this handler could do against
  // pre-finalize state. A second write here would only cost a re-render.
  window.onPermissionDenied = () => {};

  // Block reset callback — clears streaming content refs when a new assistant
  // message starts within an ongoing stream (e.g., after tool_use loop iteration).
  // This prevents cross-turn content merging where new thinking/text deltas
  // would append to previous turn's buffered content.
  window.onBlockReset = () => {
    if (!isStreamingRef.current) {
      // Stream not active, ignore (could be stale signal after stream ended)
      return;
    }
    // NOTE: content/thinking buffers are intentionally NOT cleared here.
    // The Java layer keeps ONE assistant message for the whole turn (including
    // every tool_use loop iteration), appending each turn's text/thinking as
    // additional raw blocks. Clearing the buffers on BLOCK_RESET would discard
    // the prefix carried by earlier turns and break sync*BlocksWithContent's
    // prefix reconciliation: a multi-block turn would drop new deltas (prefix
    // no longer matches) and a single-block turn would overwrite the prior
    // turn's block with the new turn's content. Keep the cumulative buffer; the
    // sync functions' trailing-block guard routes each turn's content into its
    // own block once the backend snapshot delivers it.
    // Intentionally NOT resetting streamingMessageIndexRef either: the assistant
    // message is shared across turns, so the index already points at it.
    // Reset throttle timeouts to ensure clean state for new deltas
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
    // Reset last update timestamps to prevent throttle delays
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    // Clear auto-expanded thinking keys for the new turn
    autoExpandedThinkingKeysRef.current.clear();
  };


  // ── Named data-plane events (G8) ──────────────────────────────────────
  // The host now names the owning tab on every session event. Background tabs
  // absorb their own events; only the active tab reaches the React view.
  const payloadOf = (payload: unknown): Record<string, unknown> =>
    payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};

  /**
   * 已结算过的回合键（`sessionId#turnId`），每个视图一份。
   *
   * `turn.settled` 是 daemon 的权威终止，但它可能和 `turn.ended` 并存到达、
   * 也可能因为重连被重放。没有这个集合，同一个回合会被结算两次 —— 表现是
   * 停止后指示器闪一下又恢复，或后一次把新回合的 loading 清掉。
   * 与 idea 的 `processedTurnEndKeys` 一致：有界（256），溢出整表清空。
   */
  const processedTurnEndKeys = new Set<string>();

  registerHostEvents({
    'content.delta': (payload: unknown, env?: HostEventEnvelope) => {
      const delta = String(payloadOf(payload).delta ?? '');
      if (!delta) return;
      if (updateBackgroundTab(env, (tab) => appendDeltaToTab(tab, delta))) return;
      window.onContentDelta?.(delta);
    },
    'thinking.delta': (payload: unknown, env?: HostEventEnvelope) => {
      const delta = String(payloadOf(payload).delta ?? '');
      if (!delta) return;
      if (updateBackgroundTab(env, (tab) => {
        tab.streamingActive = true;
        tab.loading = true;
        tab.isThinking = true;
      })) return;
      window.onThinkingDelta?.(delta);
    },
    'message.snapshot': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const json = typeof data.json === 'string' ? data.json : '';
      if (!json) return;
      const messages = parseEventJson<ClaudeMessage[]>(json);
      if (!messages) return;
      if (updateBackgroundTab(env, (tab) => applySnapshotToTab(tab, messages))) return;
      window.updateMessages?.(
        json,
        String(data.sequence ?? ''),
        String(data.baseIndex ?? 0),
        env?.sessionId ?? null,
      );
    },
    'message.tail': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const json = typeof data.json === 'string' ? data.json : '';
      if (!json) return;
      const messages = parseEventJson<ClaudeMessage[]>(json);
      if (!messages) return;
      const tailBase = Number(payloadOf(payload).baseIndex);
      if (updateBackgroundTab(env, (tab) => applyTailToTab(
        tab,
        messages,
        Number.isSafeInteger(tailBase) && tailBase >= 0 ? tailBase : 0,
      ))) return;
      window.updateMessageTail?.(
        json,
        String(data.baseIndex ?? 0),
        String(data.sequence ?? ''),
        env?.sessionId ?? null,
      );
    },
    'turn.heartbeat': (_payload: unknown, env?: HostEventEnvelope) => {
      if (!isActiveTabEvent(env)) return;
      window.onStreamingHeartbeat?.();
    },
    'turn.started': (_payload: unknown, env?: HostEventEnvelope) => {
      if (updateBackgroundTab(env, (tab) => {
        tab.streamingActive = true;
        tab.loading = true;
      })) return;
      window.onStreamStart?.();
    },
    'turn.ended': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const sequence = data.sequence;
      if (updateBackgroundTab(env, (tab) => {
        tab.streamingActive = false;
        tab.loading = false;
        tab.isThinking = false;
      })) return;
      // legacy `onStreamEnd` 只接受序号。此前把 reason 也塞进这个位置
      // （`JSON.stringify({reason})`），`parseSequence` 解析失败后收尾会走
      // skip 分支：只终结悬空工具调用，不清流式标志 —— 停止后 loading 因此
      // 不归零，界面停在「生成中」。
      window.onStreamEnd?.(
        typeof sequence === 'number' || typeof sequence === 'string' ? sequence : undefined,
      );
      // skip 分支不会回落 React 层的流式标志；这里补齐，等价于 idea 的
      // `onStreamEnd → finishTurn`（清 streaming/loading 并把回复定住）。
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      finalizeUnresolvedToolUses();
    },
    'turn.settled': (payload: unknown, env?: HostEventEnvelope) => {
      // 与 idea 的 `onTurnEnd` 同语义：先按线上身份定位会话（**没有身份就丢弃**，
      // 绝不理解成「当前屏上的那个 tab」），再按 (sessionId, turnId) 去重。
      const sessionId = resolveSessionId(env?.sessionId, 'onTurnEnd');
      if (sessionId === null) return;

      const data = payloadOf(payload);
      const terminal = parseEventJson<{ turnId?: string | number }>(data.terminal);
      const turnId = terminal && typeof terminal === 'object' ? terminal.turnId : undefined;
      const key = `${sessionId}#${turnId ?? 'none'}`;
      if (processedTurnEndKeys.has(key)) return;
      processedTurnEndKeys.add(key);
      if (processedTurnEndKeys.size > 256) processedTurnEndKeys.clear();

      if (updateBackgroundTab(env, (tab) => {
        tab.streamingActive = false;
        tab.loading = false;
        tab.isThinking = false;
      })) return;
      clearStallWatchdog();
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      finalizeUnresolvedToolUses();
    },
    'session.loading': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const loading = data.loading === true;
      const turnStartTime = typeof data.turnStartTime === 'number' ? data.turnStartTime : undefined;
      if (updateBackgroundTab(env, (tab) => { tab.loading = loading; })) return;
      window.showLoading?.(String(loading), turnStartTime);
    },
    'thinking.status': (payload: unknown, env?: HostEventEnvelope) => {
      const thinking = payloadOf(payload).thinking === true;
      if (updateBackgroundTab(env, (tab) => { tab.isThinking = thinking; })) return;
      window.showThinkingStatus?.(String(thinking));
    },
    'usage.updated': (payload: unknown, env?: HostEventEnvelope) => {
      const usage = payloadOf(payload).usage;
      if (updateBackgroundTab(env, (tab) => {
        const parsed = parseEventJson<{ percentage?: number; usedTokens?: number; maxTokens?: number }>(usage);
        if (parsed) {
          tab.usagePercentage = parsed.percentage ?? tab.usagePercentage;
          tab.usageUsedTokens = parsed.usedTokens ?? tab.usageUsedTokens;
          tab.usageMaxTokens = parsed.maxTokens ?? tab.usageMaxTokens;
        }
      })) return;
      if (typeof usage === 'string') window.onUsageUpdate?.(usage);
    },
    'session.bound': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
      if (updateBackgroundTab(env, (tab) => { tab.sessionId = sessionId || null; })) return;
      window.setSessionId?.(sessionId);
    },
    'status.updated': (payload: unknown, env?: HostEventEnvelope) => {
      const status = String(payloadOf(payload).status ?? '');
      if (updateBackgroundTab(env, (tab) => { tab.status = status; })) return;
      window.updateStatus?.(status);
    },
    'turn.error': (payload: unknown, env?: HostEventEnvelope) => {
      const error = String(payloadOf(payload).error ?? '');
      if (!error) return;
      // The semantic event is the authoritative terminal notice: a transcript
      // snapshot can shrink while a turn settles and drop the error row.
      onTerminalErrorFromHost({ error }, env);
      if (updateBackgroundTab(env, (tab) => { tab.status = `Error: ${error}`; })) return;
      window.updateStatus?.(`Error: ${error}`);
    },
    'message.block.reset': (_payload: unknown, env?: HostEventEnvelope) => {
      if (!isActiveTabEvent(env)) return;
      window.onBlockReset?.();
    },
    'todos.updated': (payload: unknown, env?: HostEventEnvelope) => {
      const todos = payloadOf(payload).todos;
      if (updateBackgroundTab(env, (tab) => {
        const parsed = parseEventJson(todos);
        if (Array.isArray(parsed)) tab.sseTodos = parsed as any;
      })) return;
      if (typeof todos === 'string') window.onTodoUpdated?.(todos);
    },
    'message.removed': (payload: unknown, env?: HostEventEnvelope) => {
      const idsRaw = payloadOf(payload).ids;
      const ids = parseEventJson<string[]>(idsRaw);
      if (!Array.isArray(ids) || ids.length === 0) return;
      if (updateBackgroundTab(env, (tab) => tab.transcript.removeByIds(ids))) return;
      if (typeof idsRaw === 'string') window.onMessagesRemoved?.(idsRaw);
    },
    'revert.changed': (payload: unknown, env?: HostEventEnvelope) => {
      const state = payloadOf(payload).state;
      const parsed = parseEventJson<{ hasRevert?: boolean; messageId?: string | null }>(state);
      if (updateBackgroundTab(env, (tab) => {
        tab.revertBoundaryId = parsed?.hasRevert ? (parsed.messageId ?? null) : null;
      })) return;
      if (typeof state === 'string') window.onRevertStateUpdate?.(state);
    },

    'turn.retry': (payload: unknown, env?: HostEventEnvelope) => {
      const retry = String(payloadOf(payload).retry ?? '');
      if (!retry) return;
      // A retry notice is transient; a background tab keeps its own status line.
      if (updateBackgroundTab(env, (tab) => { tab.status = retry; })) return;
      window.updateRetryStatus?.(retry);
    },
    'session.summary': (payload: unknown, env?: HostEventEnvelope) => {
      const summary = String(payloadOf(payload).summary ?? '');
      if (!summary) return;
      if (updateBackgroundTab(env, () => {})) return;
      window.showSummary?.(summary);
    },
    'message.uuid.patched': (payload: unknown, env?: HostEventEnvelope) => {
      const data = payloadOf(payload);
      const content = typeof data.content === 'string' ? data.content : '';
      const uuid = typeof data.uuid === 'string' ? data.uuid : '';
      if (!content || !uuid) return;
      if (updateBackgroundTab(env, (tab) => tab.transcript.assignProviderId(content, uuid))) return;
      window.patchMessageUuid?.(content, uuid);
    },
    'task.event': (payload: unknown, env?: HostEventEnvelope) => {
      const eventJson = String(payloadOf(payload).event ?? '');
      if (!eventJson) return;
      if (updateBackgroundTab(env, (tab) => {
        const parsed = parseEventJson<Record<string, unknown>>(eventJson);
        const task = parseTaskNotification(parsed);
        if (task) tab.taskEvents = { ...(tab.taskEvents ?? {}), [task.toolUseId]: task };
      })) return;
      window.onTaskEvent?.(eventJson);
    },
    // Core's engine-neutral terminal state for a subagent run. Both opencode
    // v1 (`task`) and v2 (`subagent`) arrive here, for inline and background
    // calls alike. Routing by the envelope session keeps a background tab's
    // state in its own record; the active tab updates the live TaskEventMap.
    'subagent.status': (payload: unknown, env?: HostEventEnvelope) => {
      const raw = payloadOf(payload).subagent;
      const json = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
      if (updateBackgroundTab(env, (tab) => {
        const task = parseSubagentStatusEvent(parseEventJson(json));
        if (task) tab.taskEvents = { ...(tab.taskEvents ?? {}), [task.toolUseId]: task };
      })) return;
      window.onSubagentStatus?.(json);
    },
    'session.cleared': (payload: unknown, env?: HostEventEnvelope) => {
      const barrier = payloadOf(payload).barrier;
      if (updateBackgroundTab(env, (tab) => {
        tab.transcript.clear();
        tab.streamingActive = false;
        // The tab lost its transcript: the older pages it could still read
        // belong to a session it no longer shows.
        tab.historyWindow = null;
      })) return;
      window.clearMessages?.(String(barrier ?? 0));
    },
    'session.loaded': (_payload: unknown, env?: HostEventEnvelope) => {
      if (!isActiveTabEvent(env)) return;
      window.historyLoadComplete?.();
    },
    'tab.state': (payload: unknown, env?: HostEventEnvelope) => {
      const raw = payloadOf(payload).state;
      const parsed = parseEventJson<{ model?: string | null; permissionMode?: string; reasoningEffort?: string }>(raw);
      if (updateBackgroundTab(env, (tab) => {
        if (parsed) {
          tab.selectedModel = parsed.model ?? tab.selectedModel;
          tab.permissionMode = (parsed.permissionMode as typeof tab.permissionMode) ?? tab.permissionMode;
          tab.reasoningEffort = (parsed.reasoningEffort as typeof tab.reasoningEffort) ?? tab.reasoningEffort;
        }
      })) return;
      const json = typeof raw === 'string' ? raw : JSON.stringify(parsed ?? {});
      window.applyBackendTabState?.(json);
    },
    'message.error': (payload: unknown) => {
      const message = String(payloadOf(payload).message ?? '');
      if (message) window.addErrorMessage?.(message);
    },
  });
}
