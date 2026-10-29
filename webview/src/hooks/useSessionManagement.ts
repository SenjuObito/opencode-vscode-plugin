import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, HistoryData, SubagentHistoryResponse, TaskEventMap, TodoItem } from '../types';
import { sendHostCommand, sendSessionCommand, sendInterrupt, sendWindowCommand, cardDebugLog } from '../utils/bridge';
import { getTabStore } from '../store/tabStore';
import { beginTransition, endTransition, isTabTransitioning } from './windowCallbacks/tabTransition';
import { clearAllPersistedExpanded } from '../utils/expandedState';

type ViewMode = 'chat' | 'history' | 'settings';

type ToastType = 'info' | 'success' | 'warning' | 'error';

const createSessionTransitionToken = () =>
  `transition-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface UseSessionManagementOptions {
  messages: ClaudeMessage[];
  loading: boolean;
  historyData: HistoryData | null;
  currentSessionId: string | null;
  currentSessionIdRef?: React.MutableRefObject<string | null>;
  currentProvider?: string;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setCurrentView: (view: ViewMode) => void;
  setCurrentSessionId: (id: string | null) => void;
  setCustomSessionTitle: (title: string | null) => void;
  setUsagePercentage: (percent: number) => void;
  setUsageUsedTokens: (tokens: number | undefined) => void;
  setUsageMaxTokens: (tokens: number | undefined) => void;
  setStatus: (status: string) => void;
  setLoading: (loading: boolean) => void;
  setIsThinking: (thinking: boolean) => void;
  setStreamingActive: (active: boolean) => void;
  setSessionLoading: (loading: boolean) => void;
  /** Clears async subagent task events so stale completions cannot leak across sessions. */
  setTaskEvents?: React.Dispatch<React.SetStateAction<TaskEventMap>>;
  /** Clears SSE todos so stale todo lists cannot leak across sessions. */
  setSseTodos?: React.Dispatch<React.SetStateAction<TodoItem[] | null>>;
  /** Clears polled sidechain histories so stale transcripts cannot leak across sessions. */
  setSubagentHistories?: React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>;
  setIsCompacting?: React.Dispatch<React.SetStateAction<boolean>>;
  setCompactingStartTime?: React.Dispatch<React.SetStateAction<number | null>>;
  /** Resets model selection to preferred first model on new session. */
  onResetToPreferredModel?: () => void;
  clearToasts: () => void;
  addToast: (message: string, type?: ToastType) => void;
  t: TFunction;
}

interface UseSessionManagementReturn {
  showInterruptConfirm: boolean;
  suppressNextStatusToastRef: React.MutableRefObject<boolean>;
  createNewSession: () => void;
  forceCreateNewSession: () => void;
  forceCreateNewSessionWithProvider: (providerId: string) => void;
  handleConfirmInterrupt: () => void;
  handleCancelInterrupt: () => void;
  loadHistorySession: (sessionId: string, targetTabId?: string | null) => void;
  deleteHistorySession: (sessionId: string) => void;
  deleteHistorySessions: (sessionIds: string[]) => void;
  exportHistorySession: (sessionId: string, title: string) => void;
  toggleFavoriteSession: (sessionId: string) => void;
  updateHistoryTitle: (sessionId: string, newTitle: string) => void;
  applyHistoryTitleLocal: (sessionId: string, newTitle: string) => void;
}

/**
 * Hook for managing session operations (create, load, delete, export, etc.)
 */
export function useSessionManagement({
  messages: _messages,
  loading,
  historyData,
  currentSessionId,
  currentSessionIdRef,
  currentProvider,
  setHistoryData,
  setMessages,
  setCurrentView,
  setCurrentSessionId,
  setCustomSessionTitle,
  setUsagePercentage,
  setUsageUsedTokens,
  setUsageMaxTokens,
  setStatus,
  setLoading: setLoadingState,
  setIsThinking,
  setStreamingActive,
  setSessionLoading,
  setTaskEvents,
  setSseTodos,
  setSubagentHistories,
  setIsCompacting,
  setCompactingStartTime,
  onResetToPreferredModel,
  clearToasts,
  addToast,
  t,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const pendingActionRef = useRef<'newSession' | null>(null);
  const suppressNextStatusToastRef = useRef(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softReloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyDataRef = useRef(historyData);
  historyDataRef.current = historyData;
  const showSessionDeletedToast = useCallback((afterSessionTransition = false) => {
    const toast = { message: t('history.sessionDeleted'), type: 'success' as const };
    if (afterSessionTransition) {
      window.__pendingSessionTransitionToast = toast;
      return;
    }
    addToast(toast.message, toast.type);
  }, [addToast, t]);

  const beginSessionTransition = useCallback((nextSessionId: string | null, nextTitle: string | null, targetTabId?: string | null) => {
    // The guard belongs to the tab that is switching. Other tabs keep their
    // own events flowing while this one loads its history.
    const transitionTabId = targetTabId ?? getTabStore().getActiveTabId() ?? null;
    const transitionToken = createSessionTransitionToken();
    beginTransition(transitionTabId, nextSessionId, transitionToken);
    // 完整会话切换会取代任何在途的同会话软刷新，释放其去抖守卫。
    if (softReloadTimeoutRef.current !== null) {
      clearTimeout(softReloadTimeoutRef.current);
      softReloadTimeoutRef.current = null;
    }
    window.__softSessionReloadInFlight = null;
    // Clear expand/collapse cache on session switch to avoid unbounded growth
    clearAllPersistedExpanded();
    // Use the single cleanup entry point exposed by useWindowCallbacks.
    // This clears both React state AND internal streaming refs in one shot.
    if (typeof window.__resetTransientUiState === 'function') {
      window.__resetTransientUiState(true);
    } else {
      // Fallback if useWindowCallbacks hasn't mounted yet (e.g. during SSR/tests)
      clearToasts();
      setStatus('');
      setLoadingState(false);
      setIsThinking(false);
      setStreamingActive(false);
      setIsCompacting?.(false);
      setCompactingStartTime?.(null);
    }
    setMessages([]);
    if (nextSessionId !== null) {
      setSessionLoading(true);
    }
    cardDebugLog('[SessionManagement] beginSessionTransition: sessionLoading set to', nextSessionId !== null, 'nextSessionId:', nextSessionId);
    // Drop async subagent events from the prior session: tool_use_ids are
    // globally unique so stale entries cannot mislabel the new session's
    // agents, but leaving them would grow the map without bound.
    if (setTaskEvents) {
      setTaskEvents({});
    }
    // Clear SSE todos from the prior session.
    if (setSseTodos) {
      setSseTodos(null);
    }
    // Sidechain histories carry full transcript arrays (potentially large).
    // Clear them on session switch for the same unbounded-growth reason; an
    // expanded card will re-fetch the sidechain it actually needs via polling.
    if (setSubagentHistories) {
      setSubagentHistories({});
    }
    if (currentSessionIdRef) {
      currentSessionIdRef.current = nextSessionId;
    }
    setCurrentSessionId(nextSessionId);
    setCustomSessionTitle(nextTitle);
    setUsagePercentage(0);
    setUsageUsedTokens(undefined);
    setUsageMaxTokens(undefined);

    if (nextSessionId === null) {
      onResetToPreferredModel?.();
    }

    // FIX: Safety timeout to auto-release the session transition guard.
    // If the backend's historyLoadComplete signal is lost (e.g., JCEF IPC failure
    // during webview reload, or a backend error that prevents the callback),
    // the tab's transition would remain active, silently dropping ALL
    // message callbacks (updateMessages, onContentDelta, onStreamStart, etc.).
    // This makes the webview appear "dead" while the backend continues working.
    if (transitionTimeoutRef.current !== null) {
      clearTimeout(transitionTimeoutRef.current);
    }
    const token = transitionToken;
    transitionTimeoutRef.current = setTimeout(() => {
      transitionTimeoutRef.current = null;
      const ended = endTransition(transitionTabId, token);
      if (ended) {
        cardDebugLog('[SessionManagement] Transition guard timed out — auto-releasing');
        setSessionLoading(false);
      }
    }, 15_000); // 15 seconds — generous enough for slow history loads
  }, [clearToasts, currentSessionIdRef, setStatus, setLoadingState, setIsThinking, setStreamingActive, setSessionLoading, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens, setTaskEvents, setSseTodos, setSubagentHistories, onResetToPreferredModel]);

  /**
   * Open a fresh, unbound tab.
   *
   * The host no longer creates a session here. A tab exists before its
   * opencode session; the first send binds both. This prevents the old
   * random-UUID "new session" that the UI could never match.
   */
  const openNewSessionTab = useCallback(() => {
    const createTab = (window as Window & { __openNewSessionTab?: () => void }).__openNewSessionTab;
    if (typeof createTab === 'function') {
      createTab();
      return;
    }
    // Startup/test fallback: clear the view. The first send still creates the
    // real session through its tab id.
    beginSessionTransition(null, null);
  }, [beginSessionTransition]);

  // Create new session
  const createNewSession = useCallback(() => {
    if (loading) {
      pendingActionRef.current = 'newSession';
      setShowInterruptConfirm(true);
    } else {
      openNewSessionTab();
    }
  }, [loading, openNewSessionTab]);

  // Force create new session (no confirmation, used by /clear /new /reset commands)
  const forceCreateNewSession = useCallback(() => {
    if (loading) {
      sendInterrupt();
    }
    openNewSessionTab();
  }, [loading, openNewSessionTab]);

  const forceCreateNewSessionWithProvider = useCallback((providerId: string) => {
    if (loading) {
      sendInterrupt();
    }
    // The provider selection travels with the tab's next send; do not create a
    // host session here.
    sendWindowCommand('settings.provider', { provider: providerId });
    openNewSessionTab();
  }, [loading, openNewSessionTab]);

  // Confirm interrupt
  const handleConfirmInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    sendInterrupt();
    openNewSessionTab();
    pendingActionRef.current = null;
  }, [openNewSessionTab]);

  // Cancel interrupt
  const handleCancelInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    pendingActionRef.current = null;
  }, []);

  // Load history session
  // 会话级模型/模式/推理力度的恢复不在此处做（历史快照的行内值从不更新，
  // 用它恢复会覆盖用户刚切换的选择）。跨会话加载时由宿主从 daemon
  // session.get 读 opencode 权威状态后经 onSessionStateRestored 推送恢复。
  /**
   * Bind a history session to a tab, or soft-reload the active one.
   *
   * <p>{@code targetTabId} is the tab the caller prepared for the session (a
   * restored history tab, a fork landing, an empty draft being promoted). With
   * it, the session comparison below must not run: the caller has already
   * pointed {@code currentSessionId} at the incoming session, so a "same
   * session" check would send only a soft reload and never bind the tab — the
   * fork appeared with an empty transcript and a stuck loading state.</p>
   */
  const loadHistorySession = useCallback((sessionId: string, targetTabId?: string | null) => {
    const session = historyDataRef.current?.sessions?.find(s => s.sessionId === sessionId);
    const activeSessionId = currentSessionIdRef?.current ?? currentSessionId;
    cardDebugLog('[SessionManagement] loadHistorySession called, sessionId:', sessionId, 'targetTabId:', targetTabId, 'currentSessionId:', activeSessionId, 'isSameSession:', sessionId === activeSessionId);

    if (targetTabId) {
      // A named tab is authoritative: bind this session to it and let the
      // host hydrate that tab. The transition guard is scoped to the tab.
      beginSessionTransition(sessionId, session?.title ?? null, targetTabId);
      window.__softSessionReloadInFlight = null;
      sendHostCommand(targetTabId, 'session.load', { sessionId, title: session?.title }, sessionId);
      setCurrentView('chat');
      return;
    }

    // Re-opening the very session already active: don't interrupt the in-flight
    // turn or wipe the view - just ask the backend to soft-reload the transcript
    // from the server. The backend sessionLoadCallback detects the same-session
    // case and routes through reloadActiveSessionMessages (reusing the
    // session_updated reload path, never interrupting).
    if (sessionId === activeSessionId) {
      // 去抖守卫：同会话软刷新已在途时不重复发送。宿主每次恢复消息后都会推送
      // onRevertStateUpdate 等事件，任何来源的重复触发都会形成
      // load_session → 恢复消息 → 事件 → load_session 的死循环（表现为消息
      // 列表持续闪烁）。守卫由 historyLoadComplete 释放，另有超时兜底。
      if (window.__softSessionReloadInFlight === sessionId) {
        cardDebugLog('[SessionManagement] same session soft reload in flight, skipping');
        setCurrentView('chat');
        return;
      }
      cardDebugLog('[SessionManagement] same session soft reload, sending load_session');
      cardDebugLog('[SessionManagement] BEFORE: tab transition=', isTabTransitioning(getTabStore().getActiveTabId()), 'softReload=', window.__softSessionReloadInFlight);
      // Set transition guard so backend's clearMessages (from restoreMessages)
      // won't reset sessionLoading to false before messages arrive — prevents
      // the empty-state flash that occurs when the tab is not transitioning.
      const softReloadTabId = getTabStore().getActiveTabId() ?? null;
      const softReloadToken = createSessionTransitionToken();
      beginTransition(softReloadTabId, sessionId, softReloadToken);
      window.__softSessionReloadInFlight = sessionId;
      cardDebugLog('[SessionManagement] AFTER: tab transition started, token set');
      if (softReloadTimeoutRef.current !== null) {
        clearTimeout(softReloadTimeoutRef.current);
      }
      softReloadTimeoutRef.current = setTimeout(() => {
        softReloadTimeoutRef.current = null;
        if (window.__softSessionReloadInFlight === sessionId) {
          window.__softSessionReloadInFlight = null;
        }
        // Safety: release transition guard if historyLoadComplete never arrived
        if (endTransition(softReloadTabId, softReloadToken)) {
          cardDebugLog('[SessionManagement] Same-session soft reload guard timed out — auto-releasing');
        }
      }, 5_000);
      sendHostCommand(getTabStore().getActiveTabId() ?? '', 'session.load', { sessionId, title: session?.title }, sessionId);
      setCurrentView('chat');
      return;
    }

    // Switching to a different session: in multi-session architecture,
    // do not interrupt the in-flight background turn.
    cardDebugLog('[SessionManagement] different session, calling beginSessionTransition');
    // Rebind the active tab to the incoming session BEFORE the transition.
    //
    // The outgoing session may still be streaming. `isActiveSession` resolves
    // against `currentSessionIdRef`, but `updateBackgroundTab` matches on
    // `tab.sessionId` — leaving the old binding in place would make the
    // outgoing session's deltas land in the tab that now displays the new one,
    // interleaving two conversations. Rebinding releases the old session, whose
    // late deltas then fall through to the logged orphan path instead of
    // corrupting the visible transcript.
    const activeTabId = getTabStore().getActiveTabId();
    if (activeTabId) {
      getTabStore().updateTabSessionId(activeTabId, sessionId);
    }
    beginSessionTransition(sessionId, session?.title ?? null);
    // The command names the session; the tab is the tab that shows it.
    sendHostCommand(activeTabId ?? '', 'session.load', { sessionId, title: session?.title }, sessionId);
    setCurrentView('chat');
  }, [beginSessionTransition, setCurrentView, currentSessionId, currentSessionIdRef]);

  // Delete history session
  const deleteHistorySession = useCallback((sessionId: string) => {
    // Send delete request to Java backend
    sendWindowCommand('history.delete', { sessionId });
    let startedSessionTransition = false;

    // Immediately update frontend state, remove session from history list
    if (historyData && historyData.sessions) {
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const remainingSessions = prevHistoryData.sessions.filter(s => s.sessionId !== sessionId);
        const deletedCount = prevHistoryData.sessions.length - remainingSessions.length;
        const deletedSession = prevHistoryData.sessions.find(s => s.sessionId === sessionId);
        const deletedMsgCount = deletedSession?.messageCount || 0;

        return {
          ...prevHistoryData,
          sessions: remainingSessions,
          total: Math.max(0, (prevHistoryData.total !== undefined ? prevHistoryData.total - (deletedMsgCount > 0 ? deletedMsgCount : deletedCount) : remainingSessions.length))
        };
      });

      // Close open tab associated with deleted session
      getTabStore().closeTabBySessionId(sessionId);

      // If deleted session is current session, clear messages and reset state
      if (sessionId === currentSessionId) {
        // [FIX] Send interrupt signal if AI is responding
        if (loading) {
          sendInterrupt();
        }
        if (getTabStore().size() === 0) {
          beginSessionTransition(null, null);
          startedSessionTransition = true;
          // Set flag to suppress next updateStatus toast
          suppressNextStatusToastRef.current = true;
          openNewSessionTab();
        } else {
          startedSessionTransition = true;
        }
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, showSessionDeletedToast, openNewSessionTab]);

  // Batch delete history sessions
  const deleteHistorySessions = useCallback((sessionIds: string[]) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    sendWindowCommand('history.deleteMany', { sessionIds: uniqueSessionIds });
    let startedSessionTransition = false;

    if (historyData && historyData.sessions) {
      const deletedSessionIds = new Set(uniqueSessionIds);
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const remainingSessions = prevHistoryData.sessions.filter(session => !deletedSessionIds.has(session.sessionId));
        const deletedCount = prevHistoryData.sessions.length - remainingSessions.length;
        const deletedMsgCount = prevHistoryData.sessions.reduce((sum, session) => (
          deletedSessionIds.has(session.sessionId) ? sum + (session.messageCount || 0) : sum
        ), 0);

        return {
          ...prevHistoryData,
          sessions: remainingSessions,
          total: Math.max(0, (prevHistoryData.total !== undefined ? prevHistoryData.total - (deletedMsgCount > 0 ? deletedMsgCount : deletedCount) : remainingSessions.length))
        };
      });

      // Close open tab(s) associated with deleted session(s)
      for (const sid of uniqueSessionIds) {
        getTabStore().closeTabBySessionId(sid);
      }

      if (currentSessionId && deletedSessionIds.has(currentSessionId)) {
        if (loading) {
          sendInterrupt();
        }
        if (getTabStore().size() === 0) {
          beginSessionTransition(null, null);
          startedSessionTransition = true;
          suppressNextStatusToastRef.current = true;
          openNewSessionTab();
        } else {
          startedSessionTransition = true;
        }
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, beginSessionTransition, showSessionDeletedToast, openNewSessionTab]);

  // Export history session
  const exportHistorySession = useCallback((sessionId: string, title: string) => {
    const session = historyDataRef.current?.sessions?.find(s => s.sessionId === sessionId);
    sendWindowCommand('history.export', {
      sessionId,
      title,
      provider: session?.provider || currentProvider || 'opencode',
    });
  }, [currentProvider]);

  // Toggle favorite status
  const toggleFavoriteSession = useCallback((sessionId: string) => {
    // Send favorite toggle request to backend
    sendWindowCommand('history.favorite', { sessionId });

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          const isFavorited = !session.isFavorited;
          return {
            ...session,
            isFavorited,
            favoritedAt: isFavorited ? Date.now() : undefined
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // Show toast
      const session = historyData.sessions.find(s => s.sessionId === sessionId);
      if (session?.isFavorited) {
        addToast(t('history.unfavorited'), 'success');
      } else {
        addToast(t('history.favorited'), 'success');
      }
    }
  }, [historyData, setHistoryData, addToast, t]);

  // Update session title
  const updateHistoryTitle = useCallback((sessionId: string, newTitle: string) => {
    // The rename is a command: it names the session it renames.
    sendSessionCommand('session.rename', sessionId, { customTitle: newTitle });

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          return {
            ...session,
            title: newTitle
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // Show success toast
      addToast(t('history.titleUpdated'), 'success');
    }
  }, [historyData, setHistoryData, addToast, t]);

  // AI-generated titles are already persisted by saveAiTitle to the JSONL
  // session file. This skips the round-trip through the customTitle endpoint,
  // which would otherwise reject titles over its length limit.
  const applyHistoryTitleLocal = useCallback((sessionId: string, newTitle: string) => {
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session =>
        session.sessionId === sessionId ? { ...session, title: newTitle } : session
      );
      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });
    }
  }, [historyData, setHistoryData]);

  return {
    showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession,
    forceCreateNewSession,
    forceCreateNewSessionWithProvider,
    handleConfirmInterrupt,
    handleCancelInterrupt,
    loadHistorySession,
    deleteHistorySession,
    deleteHistorySessions,
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
    applyHistoryTitleLocal,
  };
}
