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
import { sendBridgeEvent, cardDebugLog } from '../../../utils/bridge';
import { debugError } from '../../../utils/debug';
import { resolveSessionId } from '../../../utils/sessionIdentity';
import {
  appendOptimisticMessageIfMissing,
  ensureStreamingAssistantInList,
  getRawUuid,
  isUserMessageContentMatch,
  preserveLastAssistantIdentity,
  preserveLatestMessagesOnShrink,
  preserveStreamingAssistantContent,
  stripDuplicateTrailingToolMessages,
} from '../messageSync';
import { releaseSessionTransition } from '../sessionTransition';
import {
  parseSequence,
  getMinAcceptedSequence,
  advanceMinAcceptedSequence,
  resetMinAcceptedSequence,
} from '../sequenceBarrier';
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
    setMessages,
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
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    findLastAssistantIndex,
    extractRawBlocks,
    patchAssistantForStreaming,
    updateContextUsageData,
    closeContextUsageDialog,
    currentSessionIdRef,
  } = options;

  const ensureStreamingAssistantPreserved = (prevList: ClaudeMessage[], resultList: ClaudeMessage[]): ClaudeMessage[] => {
    const { list, streamingIndex } = ensureStreamingAssistantInList(
      prevList,
      resultList,
      isStreamingRef.current,
      streamingTurnIdRef.current,
    );
    if (streamingIndex >= 0) {
      streamingMessageIndexRef.current = streamingIndex;
    }
    return list;
  };

  const finalizeMessageList = (prevList: ClaudeMessage[], resultList: ClaudeMessage[]): ClaudeMessage[] => {
    const withoutDuplicateToolTail = stripDuplicateTrailingToolMessages(
      resultList,
      options.currentProviderRef.current,
    );
    return ensureStreamingAssistantPreserved(prevList, withoutDuplicateToolTail);
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
  const getPrependedHistoryMessageCount = (messageCount: number): number => {
    const count = window.__prependedHistoryMessageCount;
    return typeof count === 'number'
      && Number.isSafeInteger(count)
      && count >= 0
      && count <= messageCount
      ? count
      : 0;
  };

  const sessionBaseIndexMap = new Map<string, number>();

  const getBaseIndexForSession = (sessionId: string | null): number => {
    if (sessionId && sessionBaseIndexMap.has(sessionId)) {
      return sessionBaseIndexMap.get(sessionId)!;
    }
    const tab = sessionId ? window.__sessionTabsStore?.getTabs?.().find((t) => t.sessionId === sessionId) : null;
    if (tab && typeof tab.messageBaseIndex === 'number') {
      return tab.messageBaseIndex;
    }
    return typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : 0;
  };

  const setBaseIndexForSession = (sessionId: string | null, baseIndex: number): void => {
    if (sessionId) {
      sessionBaseIndexMap.set(sessionId, baseIndex);
    }
    const tab = sessionId ? window.__sessionTabsStore?.getTabs?.().find((t) => t.sessionId === sessionId) : null;
    if (tab) {
      tab.messageBaseIndex = baseIndex;
    }
    const activeSessionId = window.__sessionTabsStore?.getActiveSessionId?.() || options.currentSessionIdRef?.current;
    if (!sessionId || !activeSessionId || sessionId === activeSessionId) {
      window.__messageBaseIndex = baseIndex;
    }
  };

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
    cardDebugLog('[processUpdateMessages] called, seq:', sequence, 'isStreaming:', isStreamingRef.current, 'jsonLen:', json.length, 'transitioning:', window.__sessionTransitioning);
    // Re-check the session-transition guard inside processUpdateMessages so the
    // rAF-deferred path (window.updateMessages → setTimeout → processUpdateMessages)
    // cannot resurrect cleared messages when a transition starts between the
    // entry-point check and the deferred fire. This also catches synchronous
    // callers that bypass the entry point — addHistoryMessage / addUserMessage
    // already guard, but processUpdateMessages is the canonical setter and
    // should be self-defending.
    if (window.__sessionTransitioning) {
      const activeSessionId = window.__sessionTransitionTargetSessionId
        || options.currentSessionIdRef?.current
        || window.__sessionTabsStore?.getActiveSessionId?.();
      const isTargetActiveSession = Boolean(targetSessionId && activeSessionId && targetSessionId === activeSessionId);
      if (!isTargetActiveSession) {
        cardDebugLog('[processUpdateMessages] BLOCKED: sessionTransitioning');
        return;
      }
      cardDebugLog('[processUpdateMessages] ALLOWED during sessionTransitioning for active targetSessionId:', targetSessionId);
    }
    const effectiveSessionId = targetSessionId ?? null;
    const minAcceptedSequence = getMinAcceptedSequence(effectiveSessionId);
    if (sequence != null && sequence < minAcceptedSequence) {
      cardDebugLog('[processUpdateMessages] BLOCKED: seq', sequence, '< minAccepted', minAcceptedSequence, 'sessionId:', effectiveSessionId);
      return;
    }

    try {
      // Reconstruct per-turn footer metadata (durationMs / turnUsage) for
      // settled turns in the snapshot — the persisted transcript carries
      // neither field, so reloaded sessions lost the duration/token footer.
      // The trailing turn is skipped while streaming: live stamping owns it.
      const raw = JSON.parse(json) as unknown;
      if (!Array.isArray(raw)) return;
      const backendMessages = raw as ClaudeMessage[];
      if (sequence != null) {
        advanceMinAcceptedSequence(effectiveSessionId, sequence);
      }

      // ── 窗口语义（opencode 活跃会话滑动窗口）──
      // 第三个参数是快照对应的宿主窗口基址（全局序号）。基址变化意味着宿主
      // 窗口滑动（头部逐出）：此时做「窗口精确拼接」——保留 webview 列表中
      // 全局序号位于新基址之前的内容（分页前插的更早页 + 旧窗口头部），
      // 用新快照替换窗口部分。禁用 smart-merge / 收缩保护：索引已整体位移，
      // 按下标对齐的合并是错的。
      const baseIndex = baseIndexArg != null && baseIndexArg !== ''
        ? Number(baseIndexArg)
        : null;
      const hasWindowBase = baseIndex != null && Number.isSafeInteger(baseIndex) && baseIndex >= 0;
      const prevWindowBase = getBaseIndexForSession(effectiveSessionId);
      const windowChanged = hasWindowBase && (baseIndex as number) !== prevWindowBase;
      if (windowChanged) {
        const newBase = baseIndex as number;
        setBaseIndexForSession(effectiveSessionId, newBase);
        setMessages((prev) => {
          const listStart = window.__opencodeListStart ?? 0;
          // 保留 prev 中全局序号 < newBase 的头部（分页内容 + 旧窗口头部），
          // 弥合窗口滑动造成的空档，保证全局连续。
          const keepCount = Math.max(0, Math.min(newBase - listStart, prev.length));
          const merged = keepCount > 0
            ? [...prev.slice(0, keepCount), ...backendMessages]
            : backendMessages;
          const result = reconstructTurnMetadata(
            merged,
            { skipTrailingTurn: isStreamingRef.current },
          );
          return finalizeMessageList(prev, result);
        });
        window.__lastAcceptedMessageCount = backendMessages.length;
        refreshRestoredHistoryIfPending(backendMessages.length);
        return;
      }

      setBaseIndexForSession(effectiveSessionId, hasWindowBase ? (baseIndex as number) : 0);

      setMessages((prev) => {
        const prependedCount = getPrependedHistoryMessageCount(prev.length);
        const parsed = reconstructTurnMetadata(
          prependedCount > 0
            ? [...prev.slice(0, prependedCount), ...backendMessages]
            : backendMessages,
          { skipTrailingTurn: isStreamingRef.current },
        );
        // If streaming is active, delegate to the streaming logic
        if (isStreamingRef.current) {
          if (useBackendStreamingRenderRef.current) {
            let smartMerged = parsed.map((newMsg, i) => {
              if (i === parsed.length - 1) return newMsg;
              if (i < prev.length) {
                const oldMsg = prev[i];
                // Preserve frontend-only durationMs across backend updates
                if (typeof oldMsg.durationMs === 'number' && newMsg.type === 'assistant') {
                  newMsg = { ...newMsg, durationMs: oldMsg.durationMs };
                }
                if (oldMsg.type === 'user' && newMsg.type === 'user' && isUserMessageContentMatch(oldMsg.content || '', newMsg.content || '')) {
                  newMsg = { ...newMsg, content: oldMsg.content };
                }
                if (
                  oldMsg.timestamp === newMsg.timestamp &&
                  oldMsg.type === newMsg.type &&
                  oldMsg.content === newMsg.content
                ) {
                  return oldMsg;
                }
              }
              return newMsg;
            });

            smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
            smartMerged = preserveStreamingAssistantContent(
              prev,
              smartMerged,
              isStreamingRef,
              streamingContentRef,
              findLastAssistantIndex,
              patchAssistantForStreaming,
            );
            const result = preserveLatestMessagesOnShrink(
              prev,
              appendOptimisticMessageIfMissing(prev, smartMerged),
              options.currentProviderRef.current,
            );

            // FIX: In Claude mode, update streamingMessageIndexRef so that
            // onContentDelta knows which assistant message to update.
            let lastAssistantIdx = findLastAssistantIndex(result);
            // Verify the found assistant belongs to the current streaming turn
            if (lastAssistantIdx >= 0 && streamingTurnIdRef.current > 0 &&
                result[lastAssistantIdx].__turnId !== streamingTurnIdRef.current) {
              // Scan for the correct turn ID match (from end, consistent with findLastAssistantIndex)
              for (let i = result.length - 1; i >= 0; i--) {
                if (result[i].type === 'assistant' && result[i].__turnId === streamingTurnIdRef.current) {
                  lastAssistantIdx = i;
                  break;
                }
              }
            }
            if (lastAssistantIdx >= 0) {
              streamingMessageIndexRef.current = lastAssistantIdx;

              // Always stamp __turnId so ensureStreamingAssistantPreserved can find it,
              // even before any content delta arrives (streamingContentRef may be empty).
              if (result[lastAssistantIdx]?.__turnId !== streamingTurnIdRef.current) {
                result[lastAssistantIdx] = {
                  ...result[lastAssistantIdx],
                  __turnId: streamingTurnIdRef.current,
                };
              }

              // FIX: If there is buffered streaming content (onContentDelta may
              // fire before updateMessages), apply it to the assistant message
              // immediately to prevent content loss.
              if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                const backendContent = result[lastAssistantIdx].content || '';
                if (streamingContentRef.current.length >= backendContent.length) {
                  result[lastAssistantIdx] = patchAssistantForStreaming({
                    ...result[lastAssistantIdx],
                    content: streamingContentRef.current,
                    isStreaming: true,
                  });
                } else {
                  // Backend has more complete content; sync buffer
                  streamingContentRef.current = backendContent;
                }
              }
            }

            return finalizeMessageList(prev, result);
          }

          const lastAssistantIdx = findLastAssistantIndex(parsed);
          if (lastAssistantIdx < 0) {
            return finalizeMessageList(
              prev,
              preserveLatestMessagesOnShrink(
                prev,
                appendOptimisticMessageIfMissing(prev, parsed),
                options.currentProviderRef.current,
              ),
            );
          }
        }

        // Non-streaming case (or streaming hasn't started yet)
        if (!isStreamingRef.current) {
          // Smart merge: reuse old message objects for performance
          let smartMerged = parsed.map((newMsg, i) => {
            if (i < prev.length) {
              const oldMsg = prev[i];
              // Preserve frontend-only durationMs across backend updates
              if (typeof oldMsg.durationMs === 'number' && newMsg.type === 'assistant') {
                newMsg = { ...newMsg, durationMs: oldMsg.durationMs };
              }
              if (oldMsg.type === 'user' && newMsg.type === 'user' && isUserMessageContentMatch(oldMsg.content || '', newMsg.content || '')) {
                newMsg = { ...newMsg, content: oldMsg.content };
              }
              if (i < parsed.length - 1) {
                if (
                  oldMsg.timestamp === newMsg.timestamp &&
                  oldMsg.type === newMsg.type &&
                  oldMsg.content === newMsg.content
                ) {
                  return oldMsg;
                }
              }
            }
            return newMsg;
          });

          smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
          smartMerged = preserveLatestMessagesOnShrink(prev, smartMerged, options.currentProviderRef.current);
          return finalizeMessageList(prev, appendOptimisticMessageIfMissing(prev, smartMerged));
        }

        // Streaming + !useBackendStreamingRender: always accept the backend snapshot
        // but preserve the streaming assistant's text content (which arrives via
        // onContentDelta and is more up-to-date than the coalesced snapshot).
        //
        // Previously this branch only accepted snapshots containing tool_use blocks,
        // which caused ALL updateMessages to be silently dropped during pure-text
        // streaming.  When onStreamEnd was subsequently lost (JCEF async chain),
        // the UI appeared permanently frozen.

        let patched = [...parsed];
        patched = appendOptimisticMessageIfMissing(prev, patched);
        patched = preserveLastAssistantIdentity(prev, patched, findLastAssistantIndex);
        patched = preserveStreamingAssistantContent(
          prev,
          patched,
          isStreamingRef,
          streamingContentRef,
          findLastAssistantIndex,
          patchAssistantForStreaming,
        );
        patched = preserveLatestMessagesOnShrink(prev, patched, options.currentProviderRef.current);

        const patchedAssistantIdx = findLastAssistantIndex(patched);
        if (patchedAssistantIdx >= 0 && patched[patchedAssistantIdx]?.type === 'assistant') {
          const patchedAssistant = patched[patchedAssistantIdx];
          const currentTurnId = streamingTurnIdRef.current;
          // Stale: backend snapshot hasn't caught up — findLastAssistantIndex returns prior turn's assistant
          const isStaleSnapshot = currentTurnId > 0 && patchedAssistant.__turnId !== undefined
            && patchedAssistant.__turnId !== currentTurnId;
          if (!isStaleSnapshot) {
            streamingMessageIndexRef.current = patchedAssistantIdx;
            patched[patchedAssistantIdx] = patchAssistantForStreaming({
              ...patchedAssistant,
              __turnId: currentTurnId,
            });
          }
        }

        // Always accept the backend snapshot during streaming. The coalescer
        // (150ms minimum interval) and rAF batching (16ms) already throttle
        // updates. Skipping snapshots via a structural-change gate caused
        // StatusPanel tasks/edits to freeze during active streaming because
        // the gate suppressed message state updates, preventing downstream
        // recomputation of statusScopeMessages, useFileChanges, and
        // deriveTodosForTurn.
        return finalizeMessageList(prev, patched);
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
    if (window.__sessionTransitioning) {
      const activeSessionId = window.__sessionTabsStore?.getActiveSessionId?.() || options.currentSessionIdRef?.current;
      const isTargetActiveSession = Boolean(targetSessionId && activeSessionId && targetSessionId === activeSessionId);
      if (!isTargetActiveSession) return;
    }
    const effectiveSessionId = targetSessionId ?? null;
    const sequence = parseSequence(sequenceArg);
    const minAcceptedSequence = getMinAcceptedSequence(effectiveSessionId);
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
        advanceMinAcceptedSequence(effectiveSessionId, sequence);
      }

      setMessages((prev) => {
        const prependedCount = getPrependedHistoryMessageCount(prev.length);
        const prependedHistory = prependedCount > 0
          ? prev.slice(0, prependedCount)
          : [];
        const storedBaseIndex = getBaseIndexForSession(effectiveSessionId);
        const currentBaseIndex = typeof storedBaseIndex === 'number' && Number.isSafeInteger(storedBaseIndex)
          ? Math.max(0, storedBaseIndex)
          : 0;
        const backendMessageCount = prev.length - prependedCount;
        const hasFullPrefix = currentBaseIndex === 0 && baseIndex <= backendMessageCount;
        let merged = hasFullPrefix
          ? [...prev.slice(0, prependedCount + baseIndex), ...tail]
          : [...prependedHistory, ...tail];
        setBaseIndexForSession(effectiveSessionId, hasFullPrefix ? 0 : baseIndex);

        merged = appendOptimisticMessageIfMissing(prev, merged);
        merged = preserveLastAssistantIdentity(prev, merged, findLastAssistantIndex);
        merged = preserveStreamingAssistantContent(
          prev,
          merged,
          isStreamingRef,
          streamingContentRef,
          findLastAssistantIndex,
          patchAssistantForStreaming,
        );

        if (isStreamingRef.current) {
          const assistantIndex = findLastAssistantIndex(merged);
          if (assistantIndex >= 0 && merged[assistantIndex]?.type === 'assistant') {
            streamingMessageIndexRef.current = assistantIndex;
            const currentTurnId = streamingTurnIdRef.current;
            if (currentTurnId > 0 && merged[assistantIndex].__turnId !== currentTurnId) {
              merged[assistantIndex] = patchAssistantForStreaming({
                ...merged[assistantIndex],
                __turnId: currentTurnId,
              });
            }
          }
        }

        merged = reconstructTurnMetadata(
          merged,
          { skipTrailingTurn: isStreamingRef.current },
        );
        if (merged.length === 0 && prev.length > 0 && isStreamingRef.current) {
          return prev;
        }
        return finalizeMessageList(prev, merged);
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse message tail:', error);
    }
  };

  window.updateMessages = (arg0, arg1, arg2, arg3) => {
    let targetSessionId: string | null = null;
    let json: string;
    let sequenceArg: string | number | undefined;
    let baseIndexArg: string | number | undefined;

    const isFirstArgJson = typeof arg0 === 'string' && (arg0.trimStart().startsWith('[') || arg0.trimStart().startsWith('{'));
    if (!isFirstArgJson && typeof arg1 === 'string') {
      targetSessionId = arg0;
      json = arg1;
      sequenceArg = arg2;
      baseIndexArg = arg3;
    } else {
      targetSessionId = null;
      json = arg0;
      sequenceArg = arg1;
      baseIndexArg = arg2;
    }

    if (targetSessionId && window.__sessionTabsStore) {
      window.__sessionTabsStore.claimUnboundTab?.(targetSessionId);
    }

    const isForegroundSession = !targetSessionId
      || (targetSessionId === (window.__sessionTransitionTargetSessionId || options.currentSessionIdRef?.current))
      || (Boolean(window.__sessionTabsStore?.isActiveSession(targetSessionId)));

    if (!isForegroundSession && targetSessionId && window.__sessionTabsStore) {
      const stored = window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          try {
            const raw = JSON.parse(json);
            if (Array.isArray(raw)) {
              t.messages = raw;
            }
          } catch (e) {
            console.error('[MultiSession] Failed to parse background updateMessages', e);
          }
        }
      );
      // `stored === false` means no tab claims this session (it may be a session
      // the tab bar has not bound yet). Fall through to the active path instead
      // of dropping the snapshot: a lost snapshot shows up as a conversation
      // that simply never renders.
      if (stored) {
        return;
      }
    }

    // During session transition, ignore message updates from stale session
    // callbacks to prevent cleared messages from being restored
    cardDebugLog('[updateMessages] called, transitioning:', window.__sessionTransitioning, 'seq:', sequenceArg, 'jsonLen:', json?.length);
    if (window.__sessionTransitioning) {
      const activeSessionId = window.__sessionTransitionTargetSessionId
        || options.currentSessionIdRef?.current
        || window.__sessionTabsStore?.getActiveSessionId?.();
      const isTargetActiveSession = Boolean(targetSessionId && activeSessionId && targetSessionId === activeSessionId);
      if (!isTargetActiveSession) {
        cardDebugLog('[updateMessages] BLOCKED by sessionTransitioning');
        return;
      }
      cardDebugLog('[updateMessages] ALLOWED during sessionTransitioning for active targetSessionId:', targetSessionId);
    }
    const effectiveSessionId = targetSessionId ?? null;
    const sequence = parseSequence(sequenceArg);
    const minAcceptedSequence = getMinAcceptedSequence(effectiveSessionId);
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
      window.__pendingUpdateJson = json;
      window.__pendingUpdateSequence = sequence;
      if (pendingUpdateRaf === null) {
        const timerId = setTimeout(() => {
          pendingUpdateRaf = null;
          window.__pendingUpdateRaf = null;
          const latestJson = pendingUpdateJson;
          const latestSequence = pendingUpdateSequence;
          const latestBaseIndex = pendingUpdateBaseIndex;
          pendingUpdateJson = null;
          pendingUpdateSequence = null;
          pendingUpdateBaseIndex = null;
          window.__pendingUpdateJson = null;
          window.__pendingUpdateSequence = null;
          // A session transition may have begun while this frame was buffered.
          // processUpdateMessages re-checks the transition guard itself now, so
          // this early return is defense-in-depth — without either check, a
          // stale snapshot deferred during the outgoing session's streaming
          // would run down the non-streaming path (isStreamingRef was cleared
          // by beginSessionTransition) and resurrect the cleared messages.
          if (window.__sessionTransitioning) {
            const activeSessionId = window.__sessionTabsStore?.getActiveSessionId?.() || options.currentSessionIdRef?.current;
            const isTargetActiveSession = Boolean(targetSessionId && activeSessionId && targetSessionId === activeSessionId);
            if (!isTargetActiveSession) return;
          }
          if (latestJson) {
            processUpdateMessages(latestJson, latestSequence, latestBaseIndex, targetSessionId);
          }
        }, 16);
        pendingUpdateRaf = timerId as unknown as number;
        window.__pendingUpdateRaf = timerId as unknown as number;
      }
      return;
    }

    processUpdateMessages(json, sequence, baseIndexArg, targetSessionId);
  };

  window.updateMessageTail = (arg0, arg1, arg2, arg3) => {
    let targetSessionId: string | null = null;
    let json: string;
    let baseIndexArg: string | number;
    let sequenceArg: string | number | undefined;

    const isFirstArgJson = typeof arg0 === 'string' && (arg0.trimStart().startsWith('[') || arg0.trimStart().startsWith('{'));
    if (!isFirstArgJson && typeof arg1 === 'string') {
      targetSessionId = arg0;
      json = arg1;
      baseIndexArg = arg2 as any;
      sequenceArg = arg3;
    } else {
      targetSessionId = null;
      json = arg0;
      baseIndexArg = arg1 as any;
      sequenceArg = arg2;
    }

    if (targetSessionId && window.__sessionTabsStore) {
      window.__sessionTabsStore.claimUnboundTab?.(targetSessionId);
    }

    if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      const stored = window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          try {
            const tail = JSON.parse(json);
            if (Array.isArray(tail)) {
              const base = typeof baseIndexArg === 'number' ? baseIndexArg : Number(baseIndexArg);
              const currentMessages = t.messages || [];
              if (Number.isSafeInteger(base) && base >= 0 && base <= currentMessages.length) {
                t.messages = [...currentMessages.slice(0, base), ...tail];
              } else if (currentMessages.length > 0) {
                t.messages = [...currentMessages, ...tail];
              } else {
                t.messages = tail;
              }
              t.messageBaseIndex = Number.isSafeInteger(base) ? base : 0;
            }
          } catch (e) {
            console.error('[MultiSession] Failed to parse background updateMessageTail', e);
          }
        }
      );
      // No tab claims this session — apply to the active path rather than drop.
      if (stored) {
        return;
      }
    }

    processMessageTail(json, baseIndexArg, sequenceArg, targetSessionId);
  };

  // ── opencode 恢复分页/回源：前插更早的历史页 ──
  // 宿主窗口（恢复或活跃会话逐出）之外的历史经 `load_earlier_messages` 回源，
  // 宿主回推本回调前插。第二个参数是页起点全局序号：webview 用它维护
  // __opencodeListStart（列表首条的全局序号），后续窗口快照据此拼接。
  // __prependedHistoryMessageCount 同步累加：基址不变的同代快照走 legacy
  // 合并路径时，靠它保留已前插的页（Codex 既有机制）。
  window.updateMessagesPrepend = (json, pageStartArg) => {
    if (window.__sessionTransitioning) return;
    if (isStreamingRef.current) return;
    let parsed: ClaudeMessage[];
    try {
      parsed = JSON.parse(json) as ClaudeMessage[];
    } catch (error) {
      console.error('[Frontend] Failed to parse earlier messages page:', error);
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    const pageStart = pageStartArg != null && pageStartArg !== ''
      ? Number(pageStartArg)
      : null;
    const container = messagesContainerRef.current;
    const oldScrollHeight = container?.scrollHeight ?? 0;
    const oldScrollTop = container?.scrollTop ?? 0;

    // ── 分页累积上限：页区域超过 MAX_PAGED_MESSAGES 时丢最老的页 ──
    // 大型会话用户连点分页会让 webview state 无界增长；被裁掉的区间经
    // set_earlier_cursor 回报宿主回滚游标，下次「加载更早」可重新回源，
    // 不产生取不到的空档。
    const MAX_PAGED_MESSAGES = 800;
    let drop = 0;
    let newStart = pageStart != null && Number.isSafeInteger(pageStart) && (pageStart as number) >= 0
      ? pageStart as number
      : (window.__opencodeListStart ?? 0);
    const windowBase = window.__messageBaseIndex ?? 0;
    if (windowBase > newStart) {
      const pagedCount = windowBase - newStart;
      if (pagedCount > MAX_PAGED_MESSAGES) {
        drop = pagedCount - MAX_PAGED_MESSAGES;
        newStart += drop;
      }
    }

    setMessages((prev) => (drop > 0 ? [...parsed, ...prev].slice(drop) : [...parsed, ...prev]));
    window.__opencodeListStart = newStart;
    const prevPrepended = window.__prependedHistoryMessageCount;
    window.__prependedHistoryMessageCount =
      Math.max(0, (typeof prevPrepended === 'number' ? prevPrepended : 0) + parsed.length - drop);
    if (drop > 0) {
      sendBridgeEvent('set_earlier_cursor', JSON.stringify({
        sessionId: currentSessionIdRef.current,
        cursor: newStart,
      }));
    }
    if (container) {
      requestAnimationFrame(() => {
        const currentContainer = messagesContainerRef.current;
        if (!currentContainer) return;
        currentContainer.scrollTop = oldScrollTop + currentContainer.scrollHeight - oldScrollHeight;
      });
    }
  };

  window.onHistoryWindowInfo = (json) => {
    try {
      window.__opencodeHistoryWindow = JSON.parse(json) as NonNullable<Window['__opencodeHistoryWindow']>;
      window.dispatchEvent(new CustomEvent('opencode-history-window-info', {
        detail: window.__opencodeHistoryWindow,
      }));
    } catch (error) {
      console.error('[Frontend] Failed to parse history window info:', error);
    }
  };


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
    const payload = pendingMessages as { json: string; sequence?: number | null };
    window.updateMessages(payload.json, payload.sequence ?? undefined);
  }

  window.updateStatus = (arg0, arg1) => {
    const [targetSessionId, text] = typeof arg1 !== 'undefined' ? [arg0, arg1] : [null, arg0];

    if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.status = text;
        }
      );
      return;
    }

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
    // Turn errors are rendered directly in the message transcript and StatusNoticeBar banner;
    // suppress redundant toast notifications.
    if (typeof text === 'string' && text.startsWith('Error:')) {
      return;
    }
    addToast(message);
  };

  window.showLoading = (arg0, arg1) => {
    const value = typeof arg1 !== 'undefined' ? arg1 : arg0;
    const targetSessionId = resolveSessionId(
      typeof arg1 !== 'undefined' ? arg0 : null,
      'showLoading',
    );
    const isLoading = isTruthy(value);
    if (targetSessionId === null) return;

    if (window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.loading = isLoading;
        }
      );
      return;
    }

    // No "ignore loading=false while streaming" guard here any more.
    //
    // It existed because the turn terminal was unreliable, so an early clear had
    // to be blocked. The daemon now emits an explicit, per-session, idempotent
    // [TURN_END], so a loading=false that arrives here is authoritative: it is
    // this session's own writer saying the turn is over. Deferring it to an
    // onStreamEnd that may never arrive is what left tabs spinning forever.
    //
    // Notify backend about loading state change for tab indicator
    sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

    setLoading((prevLoading) => {
      if (isLoading) {
        if (!prevLoading) {
          setLoadingStartTime(Date.now());
        }
      } else {
        // Stamp durationMs on the last assistant message when loading ends.
        // Skip if onStreamEnd already stamped it (avoids double-write race).
        setLoadingStartTime((prevStartTime) => {
          if (prevStartTime != null) {
            const durationMs = Date.now() - prevStartTime;
            setMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].type === 'assistant') {
                  if (typeof prev[i].durationMs === 'number') return prev;
                  const next = [...prev];
                  next[i] = { ...next[i], durationMs };
                  return next;
                }
              }
              return prev;
            });
          }
          return null;
        });
      }
      return isLoading;
    });
  };

  window.showThinkingStatus = (arg0, arg1) => {
    const [targetSessionId, value] = typeof arg1 !== 'undefined' ? [typeof arg0 === 'string' ? arg0 : null, arg1] : [null, arg0];
    const isThinkingVal = isTruthy(value);
    if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.isThinking = isThinkingVal;
        }
      );
      return;
    }
    setIsThinking(isThinkingVal);
  };

  window.showSummary = (arg0, arg1) => {
    const [targetSessionId, summary] = typeof arg1 !== 'undefined' ? [arg0, arg1] : [null, arg0];
    if (!summary || !summary.trim()) return;
    if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.status = summary;
        }
      );
      return;
    }
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

  const pendingHistory = (window as unknown as Record<string, unknown>).__pendingHistoryData;
  if (pendingHistory !== undefined) {
    delete (window as unknown as Record<string, unknown>).__pendingHistoryData;
    window.setHistoryData?.(pendingHistory as any);
  }

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

  // 宿主多会话约定：(sessionId, content, uuid)。归属先解析：不属于当前活跃
  // 会话的补丁写进对应的后台 tab，绝不落到前台列表——否则又回到「拿归属当投递」
  // 的老问题。签名曾与宿主错位（宿主发 3 参、这里只收 2 参），导致 content 槽位
  // 收到的是 sessionId，整个补丁静默失效。
  const patchUuidInList = (prev: ClaudeMessage[], content: string, uuid: string): ClaudeMessage[] => {
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const message = prev[i];
      if (message.type !== 'user') continue;
      if (getRawUuid(message)) continue;

      const rawText = extractRawBlocks(message.raw)
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('\n');
      if ((message.content || '') !== content && rawText !== content) continue;

      const raw: ClaudeMessage['raw'] =
        typeof message.raw === 'object' && message.raw
          ? { ...message.raw, uuid }
          : {
              uuid,
              message: {
                content: [{ type: 'text' as const, text: message.content || content }],
              },
            };

      const next = [...prev];
      next[i] = {
        ...message,
        raw,
      };
      return next;
    }

    cardDebugLog('[patchMessageUuid] no matching unresolved user message found for content:', content);
    return prev;
  };

  window.patchMessageUuid = (arg0, arg1, arg2) => {
    const targetSessionId = resolveSessionId(arg0, 'patchMessageUuid');
    const content = arg1;
    const uuid = arg2;
    if (!targetSessionId || !content || !uuid) return;

    if (
      targetSessionId &&
      window.__sessionTabsStore &&
      !window.__sessionTabsStore.isActiveSession(targetSessionId)
    ) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.messages = patchUuidInList(t.messages ?? [], content, uuid);
        }
      );
      return;
    }

    if (window.__sessionTransitioning) return;
    setMessages((prev) => patchUuidInList(prev, content, uuid));
  };

  window.clearMessages = (arg0, arg1) => {
    const [targetSessionId, barrierSequenceArg] = typeof arg1 !== 'undefined'
      ? [typeof arg0 === 'string' ? arg0 : null, arg1]
      : (typeof arg0 === 'string' && isNaN(Number(arg0)) ? [arg0, undefined] : [null, arg0]);

    if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.messages = [];
          t.loading = false;
          t.streamingActive = false;
        }
      );
      return;
    }

    cardDebugLog('[clearMessages] called, transitioning:', window.__sessionTransitioning, 'barrierSeq:', barrierSequenceArg);
    cardDebugLog('[clearMessages] stack:', new Error().stack?.split('\n').slice(1, 4).join(' | '));
    // Advance the sequence barrier so any updateMessages still in flight from
    // the previous session are rejected. Such a snapshot may already have been
    // dispatched to JS and be sitting in the JCEF IPC channel, so neither the
    // backend's post-reset sequence check nor the __sessionTransitioning
    // time-window guard can stop it once that guard is released. The barrier is
    // the backend coalescer's post-reset updateSequence; stale snapshots carry a
    // strictly smaller sequence. Closes the "new session does not clear" race.
    const barrierSequence = parseSequence(barrierSequenceArg);
    if (barrierSequence != null) {
      resetMinAcceptedSequence(targetSessionId, barrierSequence);
    }
    // Cancel any pending deferred updateMessages to prevent stale data from
    // being applied after messages are cleared.
    if (pendingUpdateRaf !== null) {
      clearTimeout(pendingUpdateRaf);
      pendingUpdateRaf = null;
      pendingUpdateJson = null;
      pendingUpdateSequence = null;
      window.__pendingUpdateRaf = null;
      window.__pendingUpdateJson = null;
      window.__pendingUpdateSequence = null;
    }
    window.__deniedToolIds?.clear();
    window.__opencodeHistoryWindow = undefined;
    window.__opencodeListStart = 0;
    window.__prependedHistoryMessageCount = 0;
    window.__messageBaseIndex = 0;
    window.__lastAcceptedMessageCount = undefined;
    window.__pendingHistoryRefreshMessageCount = undefined;
    window.__historySurfaceRefreshEpoch = (window.__historySurfaceRefreshEpoch ?? 0) + 1;
    resetTransientUiState();
    closeContextUsageDialog();
    setMessages([]);
  };

  window.addErrorMessage = (message) => {
    addToast(message, 'error');
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
    if (window.__sessionTransitioning) return;
    setMessages((prev) => [...prev, message]);
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
    // Compute orphans inside the updater (needs the latest message list) but keep
    // the __deniedToolIds mutation OUTSIDE it — a setMessages updater must stay
    // pure, and React StrictMode double-invokes it. Mirrors onStreamEnd's pattern.
    let orphanIds: string[] = [];
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      orphanIds = collectUnresolvedToolUseIds(prev, 'all');
      // Shallow copy forces ChatMessages to re-render so the now-denied IDs are
      // picked up by BashToolGroupBlock's deniedToolIds prop.
      return prev.map(m => ({ ...m }));
    });
    for (const id of orphanIds) {
      window.__deniedToolIds.add(id);
    }
  };

  window.historyLoadComplete = (arg0, arg1) => {
    const [targetSessionId, expectedMessageCountArg] = typeof arg1 !== 'undefined'
      ? [typeof arg0 === 'string' ? arg0 : null, arg1]
      : (typeof arg0 === 'string' && isNaN(Number(arg0)) ? [arg0, undefined] : [null, arg0]);

    const isForeground = !targetSessionId
      || (targetSessionId === (window.__sessionTransitionTargetSessionId || options.currentSessionIdRef?.current))
      || (Boolean(window.__sessionTabsStore?.isActiveSession(targetSessionId)));

    if (!isForeground && targetSessionId && window.__sessionTabsStore) {
      window.__sessionTabsStore.updateBackgroundTab(
        (t) => t.sessionId === targetSessionId,
        (t) => {
          t.loading = false;
          t.streamingActive = false;
        }
      );
      // If foreground active tab is currently transitioning targeting this session, ensure guard is released
      if (window.__sessionTransitionTargetSessionId === targetSessionId) {
        releaseSessionTransition();
      }
      // If the foreground active tab is not currently loading, ensure front-end loading bar is not stranded
      options.setSessionLoading(false);
      return;
    }

    cardDebugLog('[HistoryLoadComplete] called, transitioning BEFORE release:', window.__sessionTransitioning, 'expectedMsgCount:', expectedMessageCountArg);
    cardDebugLog('[HistoryLoadComplete] stack:', new Error().stack?.split('\n').slice(1, 4).join(' | '));
    releaseSessionTransition();
    cardDebugLog('[HistoryLoadComplete] transitioning AFTER release:', window.__sessionTransitioning);
    // Immediately release sessionLoading flag
    options.setSessionLoading(false);
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

  // Legacy Codex callback — kept as no-op to avoid breaking older Java hosts.
  // Unlike historyLoadComplete, this must NOT release the session transition guard.
  window.codexHistoryPageRenderComplete = () => {};

  // =========================================================================
  // Codex History Page (paginated history loading)
  // =========================================================================

  const codexPageBuffer = new Map<string, ClaudeMessage[]>();

  window.beginCodexHistoryPage = (json: string) => {
    try {
      const { pageId, sessionId } = JSON.parse(json) as {
        pageId: string;
        sessionId: string;
      };
      if (!pageId || !sessionId) return;
      codexPageBuffer.set(pageId, []);
      // Note: __codexHistoryPageInfo is NOT updated here — it retains the
      // previous page's range so completeCodexHistoryPage can verify contiguity.
    } catch (error) {
      console.error('[Frontend] Failed to parse beginCodexHistoryPage:', error);
    }
  };

  window.appendCodexHistoryPageBatch = (pageId: string, json: string) => {
    try {
      const messages = JSON.parse(json) as ClaudeMessage[];
      if (!Array.isArray(messages)) return;
      const existing = codexPageBuffer.get(pageId);
      if (existing) {
        existing.push(...messages);
      } else {
        codexPageBuffer.set(pageId, [...messages]);
      }
    } catch (error) {
      console.error('[Frontend] Failed to parse appendCodexHistoryPageBatch:', error);
    }
  };

  window.completeCodexHistoryPage = (json: string) => {
    try {
      const {
        pageId,
        sessionId,
        mode,
        fromTurn,
        toTurn,
        totalTurns,
        hasMore,
        loadedMessageCount,
      } = JSON.parse(json) as {
        pageId: string;
        sessionId: string;
        mode: 'prepend' | 'replace';
        fromTurn: number;
        toTurn: number;
        totalTurns: number;
        hasMore: boolean;
        loadedMessageCount: number;
      };

      const buffered = codexPageBuffer.get(pageId);
      codexPageBuffer.delete(pageId);
      if (!buffered) return;

      // Ignore if session changed during transfer
      if (currentSessionIdRef.current !== sessionId) return;

      // Contiguity check: for prepend mode, the new page's toTurn must match
      // the existing page's fromTurn. If there's a gap, reject and show error.
      const existingPageInfo = window.__codexHistoryPageInfo;
      if (mode === 'prepend' && existingPageInfo) {
        if (existingPageInfo.fromTurn > 0 && toTurn !== existingPageInfo.fromTurn) {
          addToast('Codex history changed while loading; please retry', 'error');
          return;
        }
      }

      if (mode === 'replace') {
        setMessages(buffered);
        window.__prependedHistoryMessageCount = 0;
      } else {
        // prepend
        setMessages((prev) => [...buffered, ...prev]);
        window.__prependedHistoryMessageCount =
          (window.__prependedHistoryMessageCount ?? 0) + buffered.length;
      }

      // Update page info
      window.__codexHistoryPageInfo = {
        pageId,
        sessionId,
        mode,
        fromTurn,
        toTurn,
        totalTurns,
        hasMore,
        loadedMessageCount,
      };

      // Adjust streaming index for prepended messages
      if (mode === 'prepend' && options.streamingMessageIndexRef.current >= 0) {
        options.streamingMessageIndexRef.current += buffered.length;
      }
    } catch (error) {
      console.error('[Frontend] Failed to parse completeCodexHistoryPage:', error);
    }
  };

  window.addUserMessage = (content: string) => {
    if (window.__sessionTransitioning) return;
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: content || '',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => {
      // If the last message is an optimistic message with matching content,
      // skip adding — the frontend already rendered the optimistic copy.
      // Otherwise addUserMessage + optimistic create a brief duplicate until
      // the next updateMessages deduplicates them.
      const lastMsg = prev[prev.length - 1];
      if (lastMsg?.isOptimistic && lastMsg.type === 'user' && lastMsg.content === content) {
        return prev;
      }
      return [...prev, userMessage];
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
