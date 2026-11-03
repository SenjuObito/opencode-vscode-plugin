/**
 * messageCallbacks.ts
 *
 * Registers window bridge callbacks for message management:
 * updateMessages, updateStatus, showLoading, showThinkingStatus,
 * setHistoryData, clearMessages, addErrorMessage, addHistoryMessage,
 * historyLoadComplete, addUserMessage.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import type { ContextUsageData } from '../../../components/ContextUsageDialog';
import { sendBridgeEvent } from '../../../utils/bridge';
import { debugError } from '../../../utils/debug';
import { stripDuplicateTrailingToolMessages } from '../messageSync';
import {
  activeTabId,
  endTransition,
  isSessionTransitioning,
  isTabTransitioning,
  transitionTargetOfSession,
} from '../tabTransition';
import { getTabStore } from '../../../store/tabStore';
import { parseSequence } from '../parseSequence';
import { reconstructTurnMetadata } from '../../../utils/turnMetadataReconstruction';
import { collectUnresolvedToolUseIds } from './streamingCallbacks';
import i18n from '../../../i18n/config';

const isTruthy = (v: unknown) => v === true || v === 'true';


export function registerMessageCallbacks(
  options: UseWindowCallbacksOptions,
  resetTransientUiState: () => void,
  requestHistoryRenderCommit: (refreshEpoch: number) => void,
): void {
  const {
    addToast,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setHistoryData,
    userPausedRef,
    isUserAtBottomRef,
    messagesContainerRef,
    suppressNextStatusToastRef,
    streamingContentRef,
    isStreamingRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    patchAssistantForStreaming,
    updateContextUsageData,
    closeContextUsageDialog,
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

  /**
   * Port of idea's message transition guard.
   *
   * <p>A tab that is switching sessions must ignore the outgoing session's
   * late snapshots, but it must accept the session it is switching *to*.
   * Same-session history reloads and the revert soft reload are target
   * transitions: dropping their authoritative snapshot clears the transcript
   * until a later background delivery happens to restore it.</p>
   */
  const isTransitionBlocked = (targetSessionId?: string | null): boolean => {
    if (!isSessionTransitioning(targetSessionId ?? null)) {
      return false;
    }
    const transitionTarget = transitionTargetOfSession(targetSessionId ?? null);
    const isTargetActiveSession = Boolean(
      targetSessionId && transitionTarget && targetSessionId === transitionTarget,
    );
    return !isTargetActiveSession;
  };

  // During streaming, buffer updateMessages calls and process only the latest
  // one per animation frame. This prevents JSON.parse of large payloads from
  // blocking the main thread on every coalescer push (which can arrive every
  // 50ms), eliminating the "fake freeze" symptom.
  //
  // Stored on `window` so that if registerMessageCallbacks is called again
  // (e.g., HMR, parent re-render), the previous pending rAF is cancelled
  // first — preventing stale closures from executing.
  if (window.__pendingUpdateRaf != null) {
    clearTimeout(window.__pendingUpdateRaf);
    window.__pendingUpdateRaf = null;
    window.__pendingUpdateJson = null;
    window.__pendingUpdateSequence = null;
  }
  let pendingUpdateJson: string | null = null;
  let pendingUpdateRaf: number | null = null;
  let pendingUpdateSequence: number | null = null;
  let pendingUpdateBaseIndex: string | number | null | undefined = null;
  let pendingUpdateTargetSessionId: string | null = null;
  // Expose a cancellation function so onStreamEnd can cancel stale rAF-deferred
  // updateMessages calls, preventing them from overwriting the final state after
  // streaming refs are cleared.
  const cancelPendingUpdateMessages = () => {
    if (pendingUpdateRaf !== null) {
      clearTimeout(pendingUpdateRaf);
    }
    pendingUpdateRaf = null;
    pendingUpdateJson = null;
    pendingUpdateSequence = null;
    pendingUpdateBaseIndex = null;
    pendingUpdateTargetSessionId = null;
    window.__pendingUpdateRaf = null;
    window.__pendingUpdateJson = null;
    window.__pendingUpdateSequence = null;
  };
  window.__cancelPendingUpdateMessages = cancelPendingUpdateMessages;

  const requestNativeHistoryRefresh = () => {
    const refreshEpoch = (window.__historySurfaceRefreshEpoch ?? 0) + 1;
    window.__historySurfaceRefreshEpoch = refreshEpoch;
    requestHistoryRenderCommit(refreshEpoch);
  };

  const refreshRestoredHistoryIfPending = (acceptedMessageCount: number) => {
    if (window.__pendingHistoryRefreshMessageCount !== acceptedMessageCount) {
      return;
    }
    window.__pendingHistoryRefreshMessageCount = undefined;
    requestNativeHistoryRefresh();
  };

  const processUpdateMessages = (
    json: string,
    sequence: number | null = null,
    baseIndexArg?: string | number | null,
    targetSessionId?: string | null,
  ) => {
    // Re-check the session-transition guard inside processUpdateMessages so the
    // rAF-deferred path cannot resurrect cleared messages when a transition
    // starts between the entry-point check and the deferred fire.
    if (isTransitionBlocked(targetSessionId)) {
      return;
    }
    const minAcceptedSequence = window.__minAcceptedUpdateSequence ?? 0;
    if (sequence != null && sequence < minAcceptedSequence) {
      return;
    }

    try {
      // The snapshot is a host fact: the transcript owns how it lands. Older
      // pages already read into this tab stay in front of it, the head the
      // window slid past is bridged, and messages the host has not echoed
      // (optimistic bubbles, the streaming assistant) keep their own segments.
      const raw = JSON.parse(json) as unknown;
      if (!Array.isArray(raw)) return;
      const backendMessages = raw as ClaudeMessage[];
      if (sequence != null) {
        window.__minAcceptedUpdateSequence = Math.max(minAcceptedSequence, sequence);
      }

      const parsedBase = baseIndexArg != null && baseIndexArg !== '' ? Number(baseIndexArg) : null;
      const hasWindowBase = parsedBase != null && Number.isSafeInteger(parsedBase) && parsedBase >= 0;

      getTabStore().mutateActiveTranscript((transcript) => {
        transcript.applySnapshot(backendMessages, hasWindowBase ? (parsedBase as number) : 0);
        transcript.rebuildMetadata((list) => stripDuplicateTrailingToolMessages(
          reconstructTurnMetadata(list, { skipTrailingTurn: isStreamingRef.current }),
          options.currentProviderRef.current,
        ));
        if (!isStreamingRef.current) return;
        const currentTurnId = streamingTurnIdRef.current;
        const index = transcript.patchAssistant(currentTurnId, (message) => {
          const backendContent = typeof message.content === 'string' ? message.content : '';
          // The delta buffer can be ahead of the coalesced snapshot; never let
          // the snapshot roll visible text backwards.
          if (streamingContentRef.current && streamingContentRef.current.length >= backendContent.length) {
            return patchAssistantForStreaming({
              ...message,
              content: streamingContentRef.current,
              isStreaming: true,
              __turnId: currentTurnId,
            });
          }
          if (backendContent) streamingContentRef.current = backendContent;
          return { ...message, isStreaming: true, __turnId: currentTurnId };
        });
        if (index >= 0) streamingMessageIndexRef.current = index;
      });
      window.__lastAcceptedMessageCount = backendMessages.length;
      refreshRestoredHistoryIfPending(backendMessages.length);
    } catch (error) {
      console.error('[Frontend] Failed to parse messages:', error);
    }
  };

  const processMessageTail = (
    json: string,
    baseIndexArg: string | number,
    sequenceArg?: string | number,
    targetSessionId?: string | null,
  ) => {
    if (isTransitionBlocked(targetSessionId)) return;
    const sequence = parseSequence(sequenceArg);
    const minAcceptedSequence = window.__minAcceptedUpdateSequence ?? 0;
    if (sequence != null && sequence < minAcceptedSequence) return;

    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }

    const baseIndex = typeof baseIndexArg === 'number'
      ? baseIndexArg
      : Number(baseIndexArg);
    if (!Number.isSafeInteger(baseIndex) || baseIndex < 0) return;

    try {
      const tail = JSON.parse(json) as ClaudeMessage[];
      if (!Array.isArray(tail)) return;
      if (sequence != null) {
        window.__minAcceptedUpdateSequence = Math.max(minAcceptedSequence, sequence);
      }

      getTabStore().mutateActiveTranscript((transcript) => {
        transcript.applyTail(tail, baseIndex);
        // Turn footers are derived from the tail's records; while a turn is
        // still streaming its footer waits for the settle path.
        transcript.rebuildMetadata((messages) => reconstructTurnMetadata(
          messages,
          { skipTrailingTurn: isStreamingRef.current },
        ));
        if (!isStreamingRef.current) return;
        const currentTurnId = streamingTurnIdRef.current;
        const index = transcript.patchAssistant(currentTurnId, (message) => {
          const backendContent = typeof message.content === 'string' ? message.content : '';
          if (streamingContentRef.current && streamingContentRef.current.length >= backendContent.length) {
            return patchAssistantForStreaming({
              ...message,
              content: streamingContentRef.current,
              isStreaming: true,
              __turnId: currentTurnId,
            });
          }
          if (backendContent) streamingContentRef.current = backendContent;
          return { ...message, isStreaming: true, __turnId: currentTurnId };
        });
        if (index >= 0) streamingMessageIndexRef.current = index;
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse message tail:', error);
    }
  };

  window.updateMessages = (json, sequenceArg, baseIndexArg, targetSessionIdArg) => {
    // Port of idea's guard: a transition only blocks the outgoing session.
    // The session the tab is switching to is authoritative and must land.
    const targetSessionId = targetSessionIdArg ?? null;
    if (isTransitionBlocked(targetSessionId)) {
      return;
    }
    const sequence = parseSequence(sequenceArg);
    const minAcceptedSequence = window.__minAcceptedUpdateSequence ?? 0;
    if (sequence != null && sequence < minAcceptedSequence) {
      return;
    }

    // FIX: Bump stream stall watchdog — receiving updateMessages proves the
    // backend→frontend bridge is alive even between content deltas (e.g.,
    // during tool execution phases where no text is produced).
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }

    // During streaming, coalesce rapid updateMessages calls into one-per-frame.
    // The backend coalescer may push every 50ms; JSON.parse of large payloads
    // (100KB+ for long conversations) blocks the main thread and causes dropped
    // frames ("fake freeze"). Deferring to rAF ensures we only parse the latest
    // payload and yield to the browser between frames.
    if (isStreamingRef.current) {
      pendingUpdateJson = json;
      pendingUpdateSequence = sequence;
      pendingUpdateBaseIndex = baseIndexArg ?? null;
      pendingUpdateTargetSessionId = targetSessionId;
      window.__pendingUpdateJson = json;
      window.__pendingUpdateSequence = sequence;
      if (pendingUpdateRaf === null) {
        const timerId = setTimeout(() => {
          pendingUpdateRaf = null;
          window.__pendingUpdateRaf = null;
          const latestJson = pendingUpdateJson;
          const latestSequence = pendingUpdateSequence;
          const latestBaseIndex = pendingUpdateBaseIndex;
          const latestTargetSessionId = pendingUpdateTargetSessionId;
          pendingUpdateJson = null;
          pendingUpdateSequence = null;
          pendingUpdateBaseIndex = null;
          pendingUpdateTargetSessionId = null;
          window.__pendingUpdateJson = null;
          window.__pendingUpdateSequence = null;
          // A session transition may have begun while this frame was buffered.
          // processUpdateMessages re-checks the target-aware guard itself, so
          // this early return only protects against an outgoing-session frame.
          if (isTransitionBlocked(latestTargetSessionId)) return;
          if (latestJson) {
            processUpdateMessages(latestJson, latestSequence, latestBaseIndex, latestTargetSessionId);
          }
        }, 16);
        pendingUpdateRaf = timerId as unknown as number;
        window.__pendingUpdateRaf = timerId as unknown as number;
      }
      return;
    }

    processUpdateMessages(json, sequence, baseIndexArg, targetSessionId);
  };

  window.updateMessageTail = processMessageTail;


  const pendingMessages = (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
  if (typeof pendingMessages === 'string' && pendingMessages.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
    window.updateMessages(pendingMessages);
  } else if (
    pendingMessages &&
    typeof pendingMessages === 'object' &&
    typeof (pendingMessages as { json?: unknown }).json === 'string'
  ) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
    const payload = pendingMessages as {
      json: string;
      sequence?: number | null;
      targetSessionId?: string | null;
    };
    window.updateMessages(
      payload.json,
      payload.sequence ?? undefined,
      undefined,
      payload.targetSessionId ?? null,
    );
  }

  window.updateStatus = (text) => {
    // Resolve localized message if key or known legacy string is passed
    let message = text;
    if (typeof text === 'string') {
      if (text === 'New session created, you can start asking questions' || text === 'toast.newSessionCreatedReady') {
        message = i18n.t('toast.newSessionCreatedReady');
      } else if (text.startsWith('toast.') && i18n.exists(text)) {
        message = i18n.t(text);
      }
    }
    // Do not release the transition guard from generic status updates.
    setStatus(message);
    if (suppressNextStatusToastRef.current) {
      suppressNextStatusToastRef.current = false;
      return;
    }
    addToast(message);
  };

  window.showLoading = (value, turnStartTime) => {
    const isLoading = isTruthy(value);

    // FIX: Ignore loading=false during streaming — onStreamEnd handles it uniformly.
    if (!isLoading && isStreamingRef.current) {
      return;
    }

    // Notify backend about loading state change for tab indicator
    sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

    const parsedStartTime =
      turnStartTime !== undefined && turnStartTime !== null && turnStartTime !== ''
        ? Number(turnStartTime)
        : null;

    setLoading((prevLoading) => {
      if (isLoading) {
        if (parsedStartTime !== null && Number.isFinite(parsedStartTime) && parsedStartTime > 0) {
          setLoadingStartTime(parsedStartTime);
        } else if (!prevLoading) {
          setLoadingStartTime(Date.now());
        }
      } else {
        setLoadingStartTime(null);
      }
      return isLoading;
    });
  };

  window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
  window.showSummary = (summary) => {
    if (!summary || !summary.trim()) return;
    setStatus(summary);
  };
  window.setHistoryData = (data) => {
    if (typeof data === 'string') {
      try {
        setHistoryData(JSON.parse(data));
      } catch {
        setHistoryData({ success: false, error: 'Failed to parse history data' });
      }
    } else {
      setHistoryData(data);
    }
  };

  const pendingStatus = (window as unknown as Record<string, unknown>).__pendingStatusText;
  if (typeof pendingStatus === 'string' && pendingStatus.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingStatusText;
    window.updateStatus?.(pendingStatus);
  }

  const pendingLoading = window.__pendingLoadingState;
  if (typeof pendingLoading === 'boolean') {
    delete window.__pendingLoadingState;
    window.showLoading?.(pendingLoading);
  }

  const pendingUserMessage = window.__pendingUserMessage;
  if (typeof pendingUserMessage === 'string' && pendingUserMessage.length > 0) {
    delete window.__pendingUserMessage;
    window.addUserMessage?.(pendingUserMessage);
  }

  const pendingSummary = (window as unknown as Record<string, unknown>).__pendingSummaryText;
  if (typeof pendingSummary === 'string' && pendingSummary.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingSummaryText;
    window.showSummary?.(pendingSummary);
  }

  window.patchMessageUuid = (content, uuid) => {
    if (isActiveTabTransitioning()) return;
    if (!content || !uuid) return;
    getTabStore().mutateActiveTranscript((transcript) => {
      transcript.assignProviderId(content, uuid);
    });
  };

  window.clearMessages = (barrierSequenceArg) => {
    // Advance the sequence barrier so any updateMessages still in flight from
    // the previous session are rejected. Such a snapshot may already have been
    // dispatched to JS and be sitting in the JCEF IPC channel, so neither the
    // backend's post-reset sequence check nor the __sessionTransitioning
    // time-window guard can stop it once that guard is released. The barrier is
    // the backend coalescer's post-reset updateSequence; stale snapshots carry a
    // strictly smaller sequence. Closes the "new session does not clear" race.
    const barrierSequence = parseSequence(barrierSequenceArg);
    window.__minAcceptedUpdateSequence = barrierSequence ?? 0;
    // Cancel any pending deferred updateMessages to prevent stale data from
    // being applied after messages are cleared.
    if (pendingUpdateRaf !== null) {
      clearTimeout(pendingUpdateRaf);
      pendingUpdateRaf = null;
      pendingUpdateJson = null;
      pendingUpdateSequence = null;
      pendingUpdateTargetSessionId = null;
      window.__pendingUpdateRaf = null;
      window.__pendingUpdateJson = null;
      window.__pendingUpdateSequence = null;
    }
    window.__deniedToolIds?.clear();
    window.__lastAcceptedMessageCount = undefined;
    window.__pendingHistoryRefreshMessageCount = undefined;
    window.__historySurfaceRefreshEpoch = (window.__historySurfaceRefreshEpoch ?? 0) + 1;
    resetTransientUiState();
    closeContextUsageDialog();
    // The transcript is gone, so the tab's paging window is too: a stale
    // `hasEarlier` would point the disk button at the previous session.
    const tabId = activeTabId();
    if (tabId) {
      getTabStore().updateTab(tabId, (tab) => {
        tab.historyWindow = null;
      });
    }
    getTabStore().mutateActiveTranscript((transcript) => transcript.clear());
  };

  window.addErrorMessage = (message) => {
    // `message.error` is published as a named event, so the dispatcher hands
    // over the whole `{ message }` payload instead of the legacy string. A
    // toast cannot render an object (React #31), so normalize both shapes.
    const text = typeof message === 'string'
      ? message
      : (message && typeof message === 'object' && typeof message.message === 'string'
          ? message.message
          : '');
    if (text) addToast(text, 'error');
  };

  window.showContextUsageDialog = (json: string) => {
    try {
      const result = JSON.parse(json);
      const requestId = typeof result.requestId === 'string' ? result.requestId : null;
      const data: ContextUsageData = result.data || result;
      if (result.success === false) {
        if (closeContextUsageDialog(requestId)) {
          addToast(result.error || 'Failed to get context usage', 'error');
        }
        return;
      }
      updateContextUsageData(requestId, data);
    } catch (e) {
      debugError('[ContextUsage] Failed to parse context usage result:', e);
      closeContextUsageDialog();
      addToast('Failed to parse context usage data', 'error');
    }
  };

  window.onContextUsageError = (message: string, requestId?: string) => {
    if (closeContextUsageDialog(requestId)) {
      addToast(message, 'error');
    }
  };

  window.addHistoryMessage = (message: ClaudeMessage) => {
    if (isActiveTabTransitioning()) return;
    getTabStore().mutateActiveTranscript((transcript) => {
      transcript.appendRemote(message);
    });
  };


  // History load complete callback — triggers Markdown re-rendering
  // Use full shallow copy to ensure all messages trigger re-render regardless of batching timing
  // Also clear stream-ended markers since history messages don't have __turnId
  const refreshLoadedHistoryMessages = () => {
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // FIX: A replayed session may include aborted turns where some function_call
    // entries never received a function_call_output (user pressed STOP, write_stdin
    // was filtered out, etc.). Without this scan, BashToolGroupBlock / EditToolGroupBlock
    // render those tool_use blocks as perpetual loading spinners because parseBashItem
    // treats `result == null` as "still running". onStreamEnd is NEVER fired during
    // history replay, so the equivalent cleanup there does not help here.
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    // The scan reads the settled transcript; the denied set is updated once,
    // outside the write, so a repeated history reload cannot double-count.
    const tabStore = getTabStore();
    const current = tabStore.getActiveTab().transcript.getSnapshot();
    const orphanIds = current.length === 0 ? [] : collectUnresolvedToolUseIds(current, 'all');
    // Fresh message objects force every message component to repaint, so the
    // now-denied IDs are picked up even if the list itself did not change.
    tabStore.mutateActiveTranscript((transcript) => transcript.rehydrate());
    for (const id of orphanIds) {
      window.__deniedToolIds.add(id);
    }
  };

  window.historyLoadComplete = (expectedMessageCountArg) => {
    // The history arrived, so the tab that was loading may write again.
    endTransition(activeTabId());
    // Defer sessionLoading=false so the loading indicator has time to render.
    // setTimeout(0) is too fast — React 18 batches it into the same frame as
    // the message update, so the UI jumps from empty→messages with no visible
    // loading state. 300ms gives the user a brief but perceptible loading flash.
    setTimeout(() => { options.setSessionLoading(false); }, 300);
    // 同会话软刷新已完成，释放 loadHistorySession 的去抖守卫
    window.__softSessionReloadInFlight = null;
    const pendingToast = window.__pendingSessionTransitionToast;
    if (pendingToast) {
      window.__pendingSessionTransitionToast = undefined;
      addToast(pendingToast.message, pendingToast.type);
    }
    refreshLoadedHistoryMessages();

    const expectedMessageCount = typeof expectedMessageCountArg === 'number'
      ? expectedMessageCountArg
      : typeof expectedMessageCountArg === 'string' && expectedMessageCountArg.trim().length > 0
        ? Number.parseInt(expectedMessageCountArg, 10)
        : Number.NaN;
    if (Number.isSafeInteger(expectedMessageCount) && expectedMessageCount >= 0) {
      const emptyHistoryNeedsNoSnapshot = expectedMessageCount === 0
        && window.__lastAcceptedMessageCount === undefined;
      if (window.__lastAcceptedMessageCount === expectedMessageCount || emptyHistoryNeedsNoSnapshot) {
        if (emptyHistoryNeedsNoSnapshot) {
          window.__lastAcceptedMessageCount = 0;
        }
        window.__pendingHistoryRefreshMessageCount = undefined;
        requestNativeHistoryRefresh();
      } else {
        window.__pendingHistoryRefreshMessageCount = expectedMessageCount;
      }
    }
  };

  const pendingHistoryLoadComplete = window.__pendingHistoryLoadComplete;
  if (pendingHistoryLoadComplete) {
    window.__pendingHistoryLoadComplete = undefined;
    window.historyLoadComplete(pendingHistoryLoadComplete.expectedMessageCount);
  }

  window.addUserMessage = (content: string) => {
    if (isActiveTabTransitioning()) return;
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: content || '',
      timestamp: new Date().toISOString(),
    };
    getTabStore().mutateActiveTranscript((transcript) => {
      // The optimistic bubble already shows this sentence; the host echo is
      // the same message, not a second one.
      if (transcript.hasLocalMatching(content)) return;
      transcript.appendRemote(userMessage);
    });
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });
  };

}
