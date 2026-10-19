import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../types';
import type { ContextInfo } from './useWindowCallbacks';
import type { SessionTabData } from '../components/ChatHeader/types';
import type { ModelInfo, PermissionMode, ReasoningEffort } from '../components/ChatInputBox/types';
import { getFirstPreferredModelId, resolveSessionModel } from '../components/ChatInputBox/modelSelectUtils';
import { sendBridgeEvent, cardDebugLog } from '../utils/bridge';
import { clearSessionSequenceBarrier } from './windowCallbacks/sequenceBarrier';
import { releaseSessionTransition } from './windowCallbacks/sessionTransition';
import {
  DEFAULT_STREAMING_RUNTIME,
  captureStreamingRuntime,
  clearStreamingRuntime,
  restoreStreamingRuntime,
  type StreamingRuntimeRefs,
  type StreamingRuntimeSnapshot,
} from '../utils/streamingRuntime';

/** 标签中需要跨视图保持一致的结构字段；消息与运行时留在各视图本地。 */
interface SyncedTabRecord {
  id: string;
  sessionId: string | null;
  title: string;
  isCustomTitle?: boolean;
  isShared?: boolean;
  autoOpenFileEnabled?: boolean;
}

function toSyncedTabRecord(tab: SessionTabData): SyncedTabRecord {
  return {
    id: tab.id,
    sessionId: tab.sessionId,
    title: tab.title,
    isCustomTitle: tab.isCustomTitle,
    isShared: tab.isShared,
    autoOpenFileEnabled: tab.autoOpenFileEnabled,
  };
}

/** 宿主下发的是 JSON，逐字段校验，任何一条脏数据都只丢掉自己。 */
function toSyncedTabRecordFromUnknown(raw: unknown): SyncedTabRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) {
    return null;
  }
  return {
    id,
    sessionId: typeof record.sessionId === 'string' && record.sessionId.trim() !== ''
      ? record.sessionId
      : null,
    title: typeof record.title === 'string' ? record.title : '',
    isCustomTitle: record.isCustomTitle === true,
    isShared: record.isShared === true,
    autoOpenFileEnabled: typeof record.autoOpenFileEnabled === 'boolean'
      ? record.autoOpenFileEnabled
      : undefined,
  };
}

/** 别的窗口建好、本视图第一次见到的标签：运行时从空开始，内容随后由宿主补齐。 */
function makeTabFromRecord(
  record: SyncedTabRecord,
  t: TFunction,
  defaultAutoOpenFileEnabled: boolean,
): SessionTabData {
  return {
    id: record.id,
    sessionId: record.sessionId,
    title: record.title || t('common.newSession', { defaultValue: '新会话' }),
    messages: [],
    messageBaseIndex: 0,
    opencodeListStart: 0,
    prependedHistoryMessageCount: 0,
    isShared: record.isShared ?? false,
    isCustomTitle: record.isCustomTitle,
    loading: false,
    streamingActive: false,
    pendingPermissions: [],
    pendingQuestions: [],
    autoOpenFileEnabled: record.autoOpenFileEnabled ?? defaultAutoOpenFileEnabled,
    permissionMode: 'default',
    reasoningEffort: 'default',
    filteredFileChanges: [],
    contextInfo: null,
  };
}

interface UseSessionTabsOptions {  currentSessionId: string | null;
  setCurrentSessionId?: (sessionId: string | null) => void;
  sessionTitle: string | null;
  setCustomSessionTitle: (title: string | null) => void;
  updateHistoryTitle: (sessionId: string, newTitle: string) => void;
  messages: ClaudeMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  loading: boolean;
  setLoading?: (loading: boolean) => void;
  streamingActive: boolean;
  setStreamingActive?: (active: boolean) => void;
  isThinking?: boolean;
  setIsThinking?: (thinking: boolean) => void;
  status?: string;
  setStatus?: (status: string) => void;
  sessionLoading?: boolean;
  setSessionLoading?: (loading: boolean) => void;
  revertBoundaryId?: string | null;
  setRevertBoundaryId?: (id: string | null) => void;
  isCompacting?: boolean;
  setIsCompacting?: (compacting: boolean) => void;
  compactingStartTime?: number | null;
  setCompactingStartTime?: (time: number | null) => void;
  taskEvents?: Record<string, any>;
  setTaskEvents?: (events: Record<string, any>) => void;
  sseTodos?: any[] | null;
  setSseTodos?: (todos: any[] | null) => void;
  subagentHistories?: Record<string, any>;
  setSubagentHistories?: (histories: Record<string, any>) => void;
  filteredFileChanges?: any[];
  setFilteredFileChanges?: (changes: any[]) => void;
  permissionMode?: PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => void;
  selectedModel?: string;
  /**
   * `silent` marks a value restored by a tab switch rather than chosen by the
   * user, so the host can skip the "model changed" side effects (usage reset).
   */
  setSelectedModel?: (model: string, options?: { silent?: boolean; sessionId?: string | null }) => void;
  reasoningEffort?: ReasoningEffort;
  setReasoningEffort?: (effort: ReasoningEffort) => void;
  contextInfo?: ContextInfo | null;
  setContextInfo?: (info: ContextInfo | null) => void;
  availableModels?: ModelInfo[];
  currentProvider?: string;
  usagePercentage?: number;
  setUsagePercentage?: (percent: number) => void;
  usageUsedTokens?: number;
  setUsageUsedTokens?: (tokens: number | undefined) => void;
  usageMaxTokens?: number;
  setUsageMaxTokens?: (tokens: number | undefined) => void;
  loadingStartTime?: number | null;
  setLoadingStartTime?: (time: number | null) => void;
  isShared: boolean;
  setCurrentView?: (view: 'chat' | 'history' | 'settings') => void;
  chatInputRef?: React.RefObject<any>;
  defaultAutoOpenFileEnabled?: boolean;
  forceCreateNewSession: () => void;
  loadHistorySession: (sessionId: string) => void;
  currentSessionIdRef?: React.RefObject<string | null>;
  /**
   * The live streaming refs. Supplying them enables per-tab runtime exchange:
   * leaving a session archives the accumulator / turnId / index, entering one
   * loads it back. Without them a session that keeps running in the background
   * would leak its text into whichever session is activated next.
   */
  streamingRuntimeRefs?: StreamingRuntimeRefs;
  t: TFunction;
}

export function useSessionTabs({
  currentSessionId,
  currentSessionIdRef,
  setCurrentSessionId,
  sessionTitle,
  setCustomSessionTitle,
  updateHistoryTitle,
  messages,
  setMessages,
  loading,
  setLoading,
  streamingActive,
  setStreamingActive,
  isThinking,
  setIsThinking,
  status,
  setStatus,
  sessionLoading: _sessionLoading,
  setSessionLoading,
  revertBoundaryId,
  setRevertBoundaryId,
  isCompacting,
  setIsCompacting,
  compactingStartTime,
  setCompactingStartTime,
  taskEvents,
  setTaskEvents,
  sseTodos,
  setSseTodos,
  subagentHistories,
  setSubagentHistories,
  filteredFileChanges,
  setFilteredFileChanges,
  permissionMode,
  setPermissionMode,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  contextInfo,
  setContextInfo,
  availableModels = [],
  currentProvider = 'opencode',
  usagePercentage = 0,
  setUsagePercentage,
  usageUsedTokens,
  setUsageUsedTokens,
  usageMaxTokens,
  setUsageMaxTokens,
  loadingStartTime,
  setLoadingStartTime,
  isShared,
  setCurrentView,
  chatInputRef,
  defaultAutoOpenFileEnabled,
  forceCreateNewSession: _forceCreateNewSession,
  loadHistorySession,
  streamingRuntimeRefs,
  t,
}: UseSessionTabsOptions) {
  const [tabs, setTabs] = useState<SessionTabData[]>([
    {
      id: 'tab-1',
      sessionId: null,
      title: t('common.newSession', { defaultValue: '新会话' }),
      messages: [],
      isShared: false,
      // 不显式赋值：首个 tab 在设置回填完成前就创建了，留空表示跟随
      // 「发送打开的文件路径」设置（activeTabAutoOpenFileEnabled 负责兜底）。
      autoOpenFileEnabled: undefined,
      permissionMode: permissionMode || 'default',
      selectedModel: selectedModel,
      reasoningEffort: reasoningEffort || 'default',
      filteredFileChanges: [],
      contextInfo: contextInfo ?? null,
      turnStartedAt: loadingStartTime ?? null,
      usagePercentage: usagePercentage ?? 0,
      usageUsedTokens: usageUsedTokens,
      usageMaxTokens: usageMaxTokens,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const historyLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (historyLoadingTimeoutRef.current) {
        clearTimeout(historyLoadingTimeoutRef.current);
      }
    };
  }, []);

  // Keep ref to avoid stale closures in listeners
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  /**
   * Streaming runtime per tab, keyed by tab id.
   *
   * Kept out of `SessionTabData` on purpose: every background delta clones the
   * tab object (`{...tab}`), so embedding a 10-field snapshot there would make
   * that hot path copy it on every delta.
   */
  const runtimeSnapshotsRef = useRef<Map<string, StreamingRuntimeSnapshot>>(new Map());

  // Real-time runtime state ref to completely eliminate stale closures when saving snapshots
  const runtimeStateRef = useRef({
    messages,
    currentSessionId,
    sessionTitle,
    loading,
    streamingActive,
    isThinking,
    status,
    revertBoundaryId,
    isCompacting,
    compactingStartTime,
    taskEvents,
    sseTodos,
    subagentHistories,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    loadingStartTime,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
  });

  useEffect(() => {
    runtimeStateRef.current = {
      messages,
      currentSessionId,
      sessionTitle,
      loading,
      streamingActive,
      isThinking,
      status,
      revertBoundaryId,
      isCompacting,
      compactingStartTime,
      taskEvents,
      sseTodos,
      subagentHistories,
      filteredFileChanges,
      permissionMode,
      selectedModel,
      reasoningEffort,
      contextInfo,
      loadingStartTime,
      usagePercentage,
      usageUsedTokens,
      usageMaxTokens,
    };
  }, [
    messages,
    currentSessionId,
    sessionTitle,
    loading,
    streamingActive,
    isThinking,
    status,
    revertBoundaryId,
    isCompacting,
    compactingStartTime,
    taskEvents,
    sseTodos,
    subagentHistories,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    loadingStartTime,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
  ]);

  // Sync active tab's metadata as conversation progresses
  useEffect(() => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return {
            ...tab,
            sessionId: currentSessionId ?? tab.sessionId,
            title: sessionTitle || tab.title,
            isShared,
            messages,
            loading,
            streamingActive,
            isThinking,
            status,
            revertBoundaryId,
            isCompacting,
            compactingStartTime,
            taskEvents,
            sseTodos,
            subagentHistories,
            filteredFileChanges,
            permissionMode,
            selectedModel,
            reasoningEffort,
            contextInfo,
            turnStartedAt: loadingStartTime ?? tab.turnStartedAt,
            usagePercentage: usagePercentage ?? tab.usagePercentage,
            usageUsedTokens: usageUsedTokens !== undefined ? usageUsedTokens : tab.usageUsedTokens,
            usageMaxTokens: usageMaxTokens !== undefined ? usageMaxTokens : tab.usageMaxTokens,
            messageBaseIndex: typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : tab.messageBaseIndex,
            opencodeListStart: typeof window.__opencodeListStart === 'number' ? window.__opencodeListStart : tab.opencodeListStart,
            prependedHistoryMessageCount: typeof window.__prependedHistoryMessageCount === 'number' ? window.__prependedHistoryMessageCount : tab.prependedHistoryMessageCount,
          };
        }
        return tab;
      })
    );
  }, [
    activeTabId,
    currentSessionId,
    sessionTitle,
    isShared,
    messages,
    loading,
    streamingActive,
    isThinking,
    status,
    revertBoundaryId,
    isCompacting,
    compactingStartTime,
    taskEvents,
    sseTodos,
    subagentHistories,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    loadingStartTime,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
  ]);

  const isActiveSession = useCallback((sessionId: string | null | undefined): boolean => {
    if (!sessionId) return false;
    const currentActive = tabsRef.current.find((t) => t.id === activeTabIdRef.current);

    // `currentSessionIdRef` is the authority on "what the active view shows".
    // `tab.sessionId` is only its projection and can lag: `loadHistorySession`
    // swaps the visible session without rebinding the tab. Trusting the stale
    // projection would keep treating the *outgoing* session as active and
    // interleave its deltas into the new session's transcript.
    const viewSessionId = currentSessionIdRef?.current;
    if (viewSessionId) {
      if (viewSessionId === sessionId) return true;
      // The active tab stays addressable by its own tab id regardless of which
      // session it currently displays.
      return !!currentActive && currentActive.id === sessionId;
    }

    if (!currentActive) return false;
    // A tab is addressable by its own id whether or not a session is bound yet.
    if (currentActive.id === sessionId) return true;
    return currentActive.sessionId === sessionId;
  }, [currentSessionIdRef]);

  /**
   * Apply `updater` to the (single) background tab matching `predicate`.
   *
   * @returns true when a tab matched. Callers MUST check this: a false return
   *     means the write had nowhere to go, and silently ignoring it is how
   *     prompts for a session whose tab did not exist yet were lost outright
   *     (the server later settled them as rejected — the "已取消" card that
   *     never showed a dialog).
   */
  const updateBackgroundTab = useCallback((
    predicate: (tab: SessionTabData) => boolean,
    updater: (tab: SessionTabData) => void
  ): boolean => {
    // Resolve the match against the current tabs synchronously: React may defer
    // (or double-invoke, under StrictMode) the updater, so a flag set inside it
    // would not be a reliable answer for the caller.
    const snapshot = tabsRef.current;
    let matchedId: string | null = null;
    for (let i = 0; i < snapshot.length; i++) {
      if (predicate(snapshot[i])) {
        matchedId = snapshot[i].id;
        break;
      }
    }
    if (matchedId === null) {
      // Nothing matched — return the previous array so an unknown session's
      // background write costs no re-render at all (it used to rebuild the whole
      // tab list on every delta of every session).
      return false;
    }
    const targetId = matchedId;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === targetId);
      if (idx === -1) return prev;
      const next = prev.slice();
      const clone = { ...next[idx] };
      updater(clone);
      next[idx] = clone;
      return next;
    });
    return true;
  }, []);

  const updateTabSessionId = useCallback((tabId: string, sessionId: string) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === tabId || tab.sessionId === tabId) {
          return { ...tab, sessionId };
        }
        return tab;
      })
    );
    if (activeTabIdRef.current === tabId) {
      setCurrentSessionId?.(sessionId);
    }
  }, [setCurrentSessionId]);

  const updateTabTitle = useCallback(
    (sessionId: string, newTitle: string) => {
      const trimmed = newTitle?.trim();
      if (!trimmed || !sessionId) return;
      // Strict match: a title belongs only to the tab bound to that session.
      // Never route a background session's title to an unbound draft tab — that
      // made a newly created session inherit the previous session's AI title.
      const target = tabsRef.current.find((t) => t.sessionId === sessionId);
      if (!target) return;
      setTabs((prev) =>
        prev.map((tab) => (tab.sessionId === sessionId ? { ...tab, title: trimmed } : tab)),
      );
      target.title = trimmed;
      if (target.id === activeTabIdRef.current) {
        setCustomSessionTitle(trimmed);
      }
    },
    [setCustomSessionTitle]
  );

  // Forward declaration ref for closeTab
  const closeTabRef = useRef<(tabId: string) => void>(() => {});
  // Forward declaration ref for selectTab (used by focus_session from the host).
  // `remote` 标记来自其他视图的切换：本地换页，但不重复下发宿主副作用。
  const selectTabRef = useRef<(tabId: string, options?: { remote?: boolean }) => void>(() => {});

  const closeTabBySessionId = useCallback((sessionId: string) => {
    if (!sessionId) return;
    const target = tabsRef.current.find((t) => t.sessionId === sessionId);
    if (target) {
      closeTabRef.current(target.id);
    }
  }, []);

  const claimUnboundTab = useCallback((targetSessionId: string): boolean => {
    if (!targetSessionId) return false;
    const tabs = tabsRef.current;
    if (tabs.some((t) => t.sessionId === targetSessionId)) {
      return false; // already belongs to a known tab
    }
    // Prioritize currently active tab if it has no sessionId bound yet
    const activeTab = tabs.find((t) => t.id === activeTabIdRef.current);
    const unbound = (activeTab && !activeTab.sessionId)
      ? activeTab
      : tabs.find((t) => !t.sessionId);
    if (!unbound) return false;
    unbound.sessionId = targetSessionId;
    if (activeTabIdRef.current === unbound.id) {
      if (currentSessionIdRef) {
        currentSessionIdRef.current = targetSessionId;
      }
      setCurrentSessionId?.(targetSessionId);
    }
    setTabs([...tabs]);
    return true;
  }, [currentSessionIdRef, setCurrentSessionId]);

  useEffect(() => {
    window.__sessionTabsStore = {
      getActiveTabId: () => activeTabIdRef.current,
      getActiveSessionId: () => {
        // The view's authority is `currentSessionIdRef`; `tab.sessionId` can lag
        // behind it after `loadHistorySession` swaps the visible session.
        if (currentSessionIdRef?.current) return currentSessionIdRef.current;
        const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        return cur?.sessionId ?? null;
      },
      getActiveTabAutoOpenFileEnabled: () => {
        const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        return cur?.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false);
      },
      getTabs: () => tabsRef.current,
      isActiveSession,
      updateBackgroundTab,
      updateTabSessionId,
      updateTabTitle,
      closeTabBySessionId,
      claimUnboundTab,
      /**
       * 通知点击「查看」：把持有该会话的视图内标签切到前台。
       * 宿主的 `TabManager.revealSession` 负责先 reveal 原生 panel。
       */
      focusSession: (sessionId: string) => {
        if (!sessionId) return false;
        const target = tabsRef.current.find((t) => t.sessionId === sessionId);
        if (!target) return false;
        if (target.id !== activeTabIdRef.current) {
          selectTabRef.current(target.id);
        }
        return true;
      },
      archiveActiveStreamingRuntime,
      clearStreamingRuntimeFor,
    };
    return () => {
      delete window.__sessionTabsStore;
    };
  }, [isActiveSession, updateBackgroundTab, updateTabSessionId, updateTabTitle, closeTabBySessionId, claimUnboundTab]);

  // Helper: Save current active tab snapshot using real-time runtimeStateRef
  // The ref bag is passed in as a plain object, so pin it in a ref to keep the
  // capture/archive helpers dependency-free (stable identities for callbacks).
  const streamingRuntimeRefsRef = useRef(streamingRuntimeRefs);
  useEffect(() => {
    streamingRuntimeRefsRef.current = streamingRuntimeRefs;
  }, [streamingRuntimeRefs]);

  /** Archive the live streaming runtime under the tab that is leaving the view. */
  const archiveStreamingRuntime = useCallback((tabId: string) => {
    const refs = streamingRuntimeRefsRef.current;
    if (!refs) return;
    runtimeSnapshotsRef.current.set(tabId, captureStreamingRuntime(refs));
  }, []);

  /** Load the tab's archived runtime, or the default if it never streamed. */
  const restoreStreamingRuntimeFor = useCallback((tabId: string, streamingHint?: boolean) => {
    const refs = streamingRuntimeRefsRef.current;
    if (!refs) return;
    const snapshot = runtimeSnapshotsRef.current.get(tabId);
    if (snapshot) {
      restoreStreamingRuntime(refs, snapshot);
      return;
    }
    restoreStreamingRuntime(refs, DEFAULT_STREAMING_RUNTIME);
    // A tab that started streaming while in the background has tab-level flags
    // but no runtime of its own — `onStreamStart` returns early for inactive
    // sessions. Adopt the hint so the first delta does not have to rebuild it.
    if (streamingHint) {
      refs.isStreamingRef.current = true;
    }
  }, []);

  /**
   * Exposed so `beginSessionTransition` can archive before it wipes the refs.
   *
   * "Loading a different session into this tab" does not go through
   * `selectTab`, so without this hook the outgoing session's accumulator would
   * be destroyed by `__resetTransientUiState` while its turn is still running
   * in the background.
   */
  const archiveActiveStreamingRuntime = useCallback(() => {
    archiveStreamingRuntime(activeTabIdRef.current);
  }, [archiveStreamingRuntime]);

  /** Drop the archived runtime of whichever tab owns this session (stream ended). */
  const clearStreamingRuntimeFor = useCallback((sessionId: string) => {
    if (!sessionId) return;
    const owner = tabsRef.current.find((tab) => tab.sessionId === sessionId);
    if (owner) runtimeSnapshotsRef.current.delete(owner.id);
  }, []);

  /**
   * Point the host at a tab's session. Must run BEFORE any per-session bridge
   * call that follows it.
   *
   * `set_mode` / `set_model` / `set_reasoning_effort` 现在都带 `sessionId`，
   * 宿主会按 id 路由；但旧版宿主只看「窗口当前会话」，所以这里仍然先切换，
   * 保证两条路径都指向同一个会话（旧宿主不会写到别的 tab 上）。
   */
  const syncHostSessionTo = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) return;
    sendBridgeEvent('switch_session', JSON.stringify({ sessionId }));
  }, []);

  /**
   * Apply a build/plan mode to one specific session.
   *
   * The host accepts `{"sessionId","mode"}` and routes it to that session, so
   * this stays correct even if message ordering ever changes. Falls back to the
   * bare format for tabs that have not bound a session yet (the host then uses
   * whichever session is current, which for a fresh tab is the intended one).
   */
  const syncPermissionModeTo = useCallback(
    (sessionId: string | null | undefined, mode: string) => {
      if (sessionId) {
        sendBridgeEvent('set_mode', JSON.stringify({ sessionId, mode }));
      } else {
        sendBridgeEvent('set_mode', mode);
      }
    },
    [],
  );

  /**
   * Rebuild the tab strip after a webview reload.
   *
   * The reload destroys the React context, so every tab except the active one
   * disappears while Java keeps hosting all of them. Java pushes the session ids
   * it still holds; we recreate them as shells. Transcripts load on demand —
   * either when the user sends a message (which re-opens the session) or when
   * they re-open it from the history list (a same-session soft reload).
   */
  useEffect(() => {
    const restore = (json: string) => {
      let payload: { sessions?: Array<{ sessionId?: string }> };
      try {
        payload = JSON.parse(json) as { sessions?: Array<{ sessionId?: string }> };
      } catch (error) {
        cardDebugLog('[SessionTabs] restoreSessionTabs: invalid payload', error);
        return;
      }
      const incoming = (payload.sessions ?? [])
        .map((entry) => entry?.sessionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (incoming.length === 0) return;

      setTabs((prev) => {
        const known = new Set<string>();
        for (const tab of prev) {
          if (tab.sessionId) known.add(tab.sessionId);
        }
        const additions: SessionTabData[] = [];
        for (const sessionId of incoming) {
          if (known.has(sessionId)) continue;
          known.add(sessionId);
          additions.push({
            id: `tab-${Date.now()}-${additions.length}`,
            sessionId,
            // The real title arrives with the transcript; a short id prefix keeps
            // the tab identifiable in the meantime.
            title: sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId,
            messages: [],
            isShared: false,
            loading: false,
            streamingActive: false,
            permissionMode: 'default',
            reasoningEffort: 'default',
            filteredFileChanges: [],
            contextInfo: null,
          });
        }
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    };

    window.restoreSessionTabs = restore;
    return () => {
      delete window.restoreSessionTabs;
    };
  }, []);

  const saveCurrentTabSnapshot = useCallback(() => {
    const currentActive = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (currentActive) {
      const snap = runtimeStateRef.current;
      currentActive.messages = snap.messages;
      currentActive.sessionId = snap.currentSessionId;
      currentActive.title = snap.sessionTitle || currentActive.title;
      currentActive.loading = snap.loading;
      currentActive.streamingActive = snap.streamingActive;
      currentActive.isThinking = snap.isThinking;
      currentActive.status = snap.status;
      currentActive.revertBoundaryId = snap.revertBoundaryId;
      currentActive.isCompacting = snap.isCompacting;
      currentActive.compactingStartTime = snap.compactingStartTime;
      currentActive.taskEvents = snap.taskEvents;
      currentActive.sseTodos = snap.sseTodos;
      currentActive.subagentHistories = snap.subagentHistories;
      currentActive.filteredFileChanges = snap.filteredFileChanges;
      currentActive.permissionMode = snap.permissionMode;
      currentActive.selectedModel = snap.selectedModel;
      currentActive.reasoningEffort = snap.reasoningEffort;
      currentActive.contextInfo = snap.contextInfo;
      currentActive.turnStartedAt = snap.loadingStartTime ?? window.__turnStartedAt ?? null;
      currentActive.usagePercentage = snap.usagePercentage;
      currentActive.usageUsedTokens = snap.usageUsedTokens;
      currentActive.usageMaxTokens = snap.usageMaxTokens;
      currentActive.messageBaseIndex = typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : currentActive.messageBaseIndex;
      currentActive.opencodeListStart = typeof window.__opencodeListStart === 'number' ? window.__opencodeListStart : currentActive.opencodeListStart;
      currentActive.prependedHistoryMessageCount = typeof window.__prependedHistoryMessageCount === 'number' ? window.__prependedHistoryMessageCount : currentActive.prependedHistoryMessageCount;

      const currentDraftText = chatInputRef?.current?.getValue?.() ?? '';
      currentActive.draft = {
        text: currentDraftText,
        // Attachments and file tags live inside the input box (uncontrolled
        // mode), so they must be pulled out explicitly — writing an empty array
        // here silently discarded every pending upload on every tab switch.
        attachments: chatInputRef?.current?.getAttachments?.() ?? [],
        fileTags: chatInputRef?.current?.getFileTags?.() ?? [],
        quotes: chatInputRef?.current?.getQuotes?.() ?? {},
      };
      if (window.__dialogStore) {
        const dialogSnap = window.__dialogStore.getSnapshot();
        currentActive.pendingPermissions = dialogSnap.permissions;
        currentActive.pendingQuestions = dialogSnap.questions;
      }

      // The tab is leaving the viewport: freeze its streaming runtime so a
      // background turn keeps accumulating into this tab, not into the next one.
      archiveStreamingRuntime(currentActive.id);
    }
  }, [chatInputRef, archiveStreamingRuntime]);

  // Select tab (pure view switch: preserves background generation, never interrupts)
  const selectTab = useCallback(
    (targetTabId: string, options?: { remote?: boolean }) => {
      if (targetTabId === activeTabIdRef.current) return;

      saveCurrentTabSnapshot();

      const targetTab = tabsRef.current.find((t) => t.id === targetTabId);
      if (!targetTab) return;

      // Whether this switch actually replaces the rendered transcript. A no-op
      // switch must not spend a full OSR publication pulse.
      const contentChanged = targetTab.messages !== runtimeStateRef.current.messages;

      activeTabIdRef.current = targetTabId;
      setActiveTabId(targetTabId);

      // A transition toward *another* session may still be in flight (its
      // history is loading). The guard is global, and the streaming paths bail
      // out on `__sessionTransitioning` unconditionally — so leaving it set
      // while the user looks at a different tab would silently drop every delta
      // that arrives for the tab now on screen. Abandon the transition instead.
      const pendingTransitionTarget = window.__sessionTransitionTargetSessionId ?? null;
      if (
        window.__sessionTransitioning
        && pendingTransitionTarget
        && pendingTransitionTarget !== targetTab.sessionId
      ) {
        releaseSessionTransition();
      }

      // Switch the host's session first: every per-session bridge call below
      // (mode / model / reasoning effort) is applied to whatever session the
      // window currently points at.
      //
      // 远端同步（另一个窗口发起的切换）跳过这一步：宿主就是切换的发起方，
      // 它的当前会话已经指向目标；再发一次 switch_session 会触发重复水化，
      // 把正在流式的视图整份替换掉。
      if (!options?.remote) {
        syncHostSessionTo(targetTab.sessionId);
      }

      // Restore target tab's snapshot into active view
      if (currentSessionIdRef) {
        currentSessionIdRef.current = targetTab.sessionId;
      }
      setCurrentSessionId?.(targetTab.sessionId);
      setCustomSessionTitle(targetTab.title || null);
      // 同步 Tab 标题到 IDE ToolWindow，切换 Tab 时跟随标签页标题
      sendBridgeEvent('update_tab_title', targetTab.title || '');
      setMessages(targetTab.messages || []);
      // Exchange the streaming runtime immediately after the transcript swap:
      // the next delta must see this tab's accumulator, and the message index is
      // intentionally reset so the live assistant is re-located in the new array.
      restoreStreamingRuntimeFor(targetTab.id, targetTab.streamingActive);
      setLoading?.(targetTab.loading || false);
      setStreamingActive?.(targetTab.streamingActive || false);
      setIsThinking?.(targetTab.isThinking || false);
      setStatus?.(targetTab.status || '');
      setRevertBoundaryId?.(targetTab.revertBoundaryId ?? null);
      setIsCompacting?.(targetTab.isCompacting || false);
      setCompactingStartTime?.(targetTab.compactingStartTime ?? null);
      setTaskEvents?.(targetTab.taskEvents || {});
      setSseTodos?.(targetTab.sseTodos || null);
      setSubagentHistories?.(targetTab.subagentHistories || {});
      setFilteredFileChanges?.(targetTab.filteredFileChanges || []);

      // Restore per-tab sliding window cursors into window
      window.__messageBaseIndex = targetTab.messageBaseIndex ?? 0;
      window.__opencodeListStart = targetTab.opencodeListStart ?? 0;
      window.__prependedHistoryMessageCount = targetTab.prependedHistoryMessageCount ?? 0;

      // Restore session model & mode & reasoning effort.
      // `setSelectedModel` / `setReasoningEffort` are the App-level handlers and
      // already push their value to the host — do not send a second time here.
      // 尚未绑定会话的 tab 以 tabId 作为宿主键（首个 set_* 会按它补建会话），
      // 不能用裸值下发：裸值会落到「窗口当前会话」，也就是上一个 tab。
      const tabSessionKey = targetTab.sessionId ?? targetTab.id;
      const targetMode = targetTab.permissionMode || 'default';
      setPermissionMode?.(targetMode);
      if (!options?.remote) {
        syncPermissionModeTo(tabSessionKey, targetMode);
      }

      const targetEffort = targetTab.reasoningEffort || 'default';
      setReasoningEffort?.(targetEffort);

      const resolvedModel = resolveSessionModel(
        targetTab.selectedModel,
        currentProvider || 'opencode',
        availableModels || [],
      );
      if (resolvedModel && !options?.remote) {
        setSelectedModel?.(resolvedModel, { silent: true, sessionId: tabSessionKey });
      }

      // 文件上下文跟随 tab：先清掉上一个 tab 的 chip，再让宿主按本 tab 的开关
      // 补推当前编辑器上下文（关闭时宿主会回 clearSelectionInfo）。
      const isAutoOpen = targetTab.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false);
      setContextInfo?.(targetTab.contextInfo ?? null);
      sendBridgeEvent('refresh_editor_context', JSON.stringify({ tabId: targetTab.id, enabled: isAutoOpen }));

      // Restore turnStartedAt & usage tracking to prevent cross-session pollution
      const targetTurnStartedAt = targetTab.turnStartedAt ?? null;
      setLoadingStartTime?.(targetTurnStartedAt);
      window.__turnStartedAt = targetTurnStartedAt ?? undefined;

      setUsagePercentage?.(targetTab.usagePercentage ?? 0);
      setUsageUsedTokens?.(targetTab.usageUsedTokens);
      setUsageMaxTokens?.(targetTab.usageMaxTokens);

      // Restore input box draft. Order matters: text first, then attachments,
      // then file tags — `restoreFileTags` re-renders chips out of the restored
      // text, so it has to run last.
      // The attachment restore is deliberately NOT gated behind `setValue`:
      // attachments are the one piece of state that must never survive a tab
      // switch, and gating it on any single handle made a missing ref silently
      // leave the outgoing tab's uploads behind.
      const inputHandle = chatInputRef?.current;
      inputHandle?.setValue?.(targetTab.draft?.text ?? '');
      inputHandle?.setAttachments?.(targetTab.draft?.attachments ?? []);
      inputHandle?.restoreFileTags?.(targetTab.draft?.fileTags ?? []);
      inputHandle?.restoreQuoteTags?.(targetTab.draft?.quotes ?? {});

      // Switching tabs must NEVER show "loading history session" in status bar
      setSessionLoading?.(false);

      // Restore target tab's dialog state
      if (window.__dialogStore) {
        window.__dialogStore.restore(
          targetTab.pendingPermissions || [],
          targetTab.pendingQuestions || []
        );
      }

      // Publish the swapped transcript once. On OSR the surface still holds the
      // outgoing tab's backing image, and the next natural paint may be a long
      // way off (e.g. an idle session); the fence forces a clean full frame.
      if (contentChanged) {
        window.__requestSurfaceRepublish?.();
      }
    },
    [
      saveCurrentTabSnapshot,
      restoreStreamingRuntimeFor,
      syncHostSessionTo,
      syncPermissionModeTo,
      setCurrentSessionId,
      setCustomSessionTitle,
      setMessages,
      setLoading,
      setStreamingActive,
      setIsThinking,
      setStatus,
      setRevertBoundaryId,
      setIsCompacting,
      setCompactingStartTime,
      setTaskEvents,
      setSseTodos,
      setSubagentHistories,
      setFilteredFileChanges,
      setPermissionMode,
      setReasoningEffort,
      setSelectedModel,
      setContextInfo,
      setLoadingStartTime,
      setUsagePercentage,
      setUsageUsedTokens,
      setUsageMaxTokens,
      currentProvider,
      availableModels,
      setSessionLoading,
      chatInputRef,
    ]
  );

  // Open session in tab (from history: jump if already open, create new tab if not)
  const openSessionInTab = useCallback(
    (
      sessionId: string,
      title?: string,
      historyModel?: string,
      historyMode?: string,
      historyEffort?: string
    ) => {
      // 1. If this session is already open in a tab, jump to it!
      const existingTab = tabsRef.current.find((t) => t.sessionId === sessionId);
      if (existingTab) {
        selectTab(existingTab.id);
        setCurrentView?.('chat');
        setSessionLoading?.(false);
        return;
      }

      const resolvedModel = resolveSessionModel(
        historyModel,
        currentProvider || 'opencode',
        availableModels || [],
      );
      const resolvedMode = (historyMode as PermissionMode) || 'default';
      const resolvedEffort = (historyEffort as ReasoningEffort) || 'default';

      // 2. Not open yet: check if current tab is a blank draft tab (no messages, no sessionId)
      const currentActive = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const isCurrentEmptyDraft =
        currentActive &&
        currentActive.sessionId === null &&
        (!messages || messages.length === 0) &&
        (!currentActive.messages || currentActive.messages.length === 0);

      const resolvedTitle = title || t('common.historySession', { defaultValue: '历史会话' });
      // 加载历史会话时按当前设置初始化该 tab 的文件上下文开关
      const loadedAutoOpenFileEnabled = defaultAutoOpenFileEnabled ?? false;
      const targetTabId = isCurrentEmptyDraft && currentActive
        ? currentActive.id
        : `tab-${Date.now()}`;

      if (isCurrentEmptyDraft && currentActive) {
        // Reuse current blank draft tab
        const updatedTabs = tabsRef.current.map((t) =>
          t.id === currentActive.id
            ? {
                ...t,
                sessionId,
                title: resolvedTitle,
                pendingPermissions: [],
                pendingQuestions: [],
                selectedModel: resolvedModel,
                permissionMode: resolvedMode,
                reasoningEffort: resolvedEffort,
                filteredFileChanges: [],
                contextInfo: null,
                autoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
              }
            : t
        );
        tabsRef.current = updatedTabs;
        setTabs(updatedTabs);
        if (currentSessionIdRef) {
          currentSessionIdRef.current = sessionId;
        }
        setCurrentSessionId?.(sessionId);
        setCustomSessionTitle(resolvedTitle);
      } else {
        // Create new tab for this history session
        saveCurrentTabSnapshot();

        const newId = targetTabId;
        const newTab: SessionTabData = {
          id: newId,
          sessionId,
          title: resolvedTitle,
          messages: [],
          isShared: false,
          loading: false,
          streamingActive: false,
          pendingPermissions: [],
          pendingQuestions: [],
          autoOpenFileEnabled: loadedAutoOpenFileEnabled,
          selectedModel: resolvedModel,
          permissionMode: resolvedMode,
          reasoningEffort: resolvedEffort,
          filteredFileChanges: [],
          contextInfo: null,
        };

        const updatedTabs = [...tabsRef.current, newTab];
        tabsRef.current = updatedTabs;
        activeTabIdRef.current = newId;
        setTabs(updatedTabs);
        setActiveTabId(newId);
        if (currentSessionIdRef) {
          currentSessionIdRef.current = sessionId;
        }
        setCurrentSessionId?.(sessionId);
        setCustomSessionTitle(resolvedTitle);
      }

      // Point the host at this session before the mode/model calls below.
      syncHostSessionTo(sessionId);

      // 历史会话按设置初始化文件上下文后，让宿主同步当前编辑器上下文到本视图
      setContextInfo?.(null);
      sendBridgeEvent(
        'refresh_editor_context',
        JSON.stringify({ tabId: targetTabId, enabled: loadedAutoOpenFileEnabled }),
      );

      // 同步 Tab 标题到 IDE ToolWindow，切换历史会话 Tab 时跟随标签页标题
      sendBridgeEvent('update_tab_title', resolvedTitle);

      setMessages([]);
      setLoading?.(false);
      setStreamingActive?.(false);
      setIsThinking?.(false);
      setStatus?.('');
      setRevertBoundaryId?.(null);
      setIsCompacting?.(false);
      setCompactingStartTime?.(null);
      setTaskEvents?.({});
      setSseTodos?.(null);
      setSubagentHistories?.({});
      setFilteredFileChanges?.([]);

      // Restore session model & mode & reasoning effort.
      // The App-level setters already push their value to the host, so the only
      // explicit call is the session-scoped mode.
      if (resolvedModel) {
        setSelectedModel?.(resolvedModel, { silent: true });
      }
      setPermissionMode?.(resolvedMode);
      syncPermissionModeTo(sessionId, resolvedMode);
      setReasoningEffort?.(resolvedEffort);

      // Reset timer & usage for newly opened history session
      setLoadingStartTime?.(null);
      window.__turnStartedAt = undefined;
      setUsagePercentage?.(0);
      setUsageUsedTokens?.(undefined);
      setUsageMaxTokens?.(undefined);

      chatInputRef?.current?.setValue?.('');
      // Same as a brand-new tab: the restored session has no draft, so the
      // outgoing tab's pending attachments must not ride along.
      chatInputRef?.current?.setAttachments?.([]);
      chatInputRef?.current?.restoreFileTags?.([]);
      chatInputRef?.current?.restoreQuoteTags?.({});
      setCurrentView?.('chat');

      // Only opening explicitly from history drawer triggers the loading bar
      setSessionLoading?.(true);

      // Safety guard: cancel any existing loading timeout and ensure automatic release after 8s
      if (historyLoadingTimeoutRef.current) {
        clearTimeout(historyLoadingTimeoutRef.current);
      }
      historyLoadingTimeoutRef.current = setTimeout(() => {
        setSessionLoading?.(false);
      }, 8000);

      // Loading fresh session resets active dialog state
      window.__dialogStore?.clearActive?.();

      // Load session via unified session management state machine
      if (loadHistorySession) {
        loadHistorySession(sessionId);
      } else {
        sendBridgeEvent('load_session', JSON.stringify({ sessionId }));
      }
    },
    [
      selectTab,
      saveCurrentTabSnapshot,
      messages,
      defaultAutoOpenFileEnabled,
      loadHistorySession,
      t,
      currentProvider,
      availableModels,
      setCurrentSessionId,
      setCustomSessionTitle,
      setMessages,
      setLoading,
      setStreamingActive,
      setIsThinking,
      setStatus,
      setRevertBoundaryId,
      setIsCompacting,
      setCompactingStartTime,
      setTaskEvents,
      setSseTodos,
      setSubagentHistories,
      setFilteredFileChanges,
      setSelectedModel,
      setPermissionMode,
      setReasoningEffort,
      setContextInfo,
      setLoadingStartTime,
      setUsagePercentage,
      setUsageUsedTokens,
      setUsageMaxTokens,
      setCurrentView,
      setSessionLoading,
      chatInputRef,
    ]
  );

  // Create new session tab (independent tab, does NOT interrupt background tabs)
  const createTab = useCallback(() => {
    saveCurrentTabSnapshot();

    // Ensure at most ONE unbound new session tab exists across all tabs
    const existingUnbound = tabsRef.current.find((t) => !t.sessionId);
    if (existingUnbound) {
      selectTab(existingUnbound.id);
      return;
    }

    const defaultModel = getFirstPreferredModelId(
      currentProvider || 'opencode',
      availableModels || [],
    ) || '';

    const newId = `tab-${Date.now()}`;
    const newTab: SessionTabData = {
      id: newId,
      sessionId: null,
      title: t('common.newSession', { defaultValue: '新会话' }),
      messages: [],
      messageBaseIndex: 0,
      opencodeListStart: 0,
      prependedHistoryMessageCount: 0,
      isShared: false,
      loading: false,
      streamingActive: false,
      pendingPermissions: [],
      pendingQuestions: [],
      autoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
      selectedModel: defaultModel,
      permissionMode: 'default',
      reasoningEffort: 'default',
      filteredFileChanges: [],
      contextInfo: null,
    };

    const updatedTabs = [...tabsRef.current, newTab];
    tabsRef.current = updatedTabs;
    activeTabIdRef.current = newId;
    setTabs(updatedTabs);
    setActiveTabId(newId);
    if (currentSessionIdRef) {
      currentSessionIdRef.current = null;
    }
    setCurrentSessionId?.(null);
    setCustomSessionTitle(null);
    setMessages([]);
    window.__messageBaseIndex = 0;
    window.__opencodeListStart = 0;
    window.__prependedHistoryMessageCount = 0;
    setLoading?.(false);
    setStreamingActive?.(false);
    setIsThinking?.(false);
    setStatus?.('');
    setRevertBoundaryId?.(null);
    setIsCompacting?.(false);
    setCompactingStartTime?.(null);
    setTaskEvents?.({});
    setSseTodos?.(null);
    setSubagentHistories?.({});
    setFilteredFileChanges?.([]);

    // Set model, mode, effort for brand new tab.
    // 必须带上本 tab 的 id：裸值会被宿主当成「窗口当前会话」，也就是上一个
    // tab 的会话——新建 tab 会把上一个对话的模型/模式静默改掉。
    if (defaultModel) {
      // setSelectedModel 内部已经下发 set_model，这里不能再补一次裸值。
      setSelectedModel?.(defaultModel, { sessionId: newId });
    }
    setPermissionMode?.('default');
    sendBridgeEvent('set_mode', JSON.stringify({ sessionId: newId, mode: 'default' }));
    setReasoningEffort?.('default');
    sendBridgeEvent(
      'set_reasoning_effort',
      JSON.stringify({ sessionId: newId, reasoningEffort: 'default' }),
    );

    // Reset turn timer & usage metrics for new tab
    setLoadingStartTime?.(null);
    window.__turnStartedAt = undefined;
    setUsagePercentage?.(0);
    setUsageUsedTokens?.(undefined);
    setUsageMaxTokens?.(undefined);

    chatInputRef?.current?.setValue?.('');
    // Attachments / file tags / quotes live inside the input box (uncontrolled
    // mode): clearing only the text left the previous tab's pending uploads
    // attached to the brand-new tab. Mirrors the draft restore in `selectTab`.
    chatInputRef?.current?.setAttachments?.([]);
    chatInputRef?.current?.restoreFileTags?.([]);
    chatInputRef?.current?.restoreQuoteTags?.({});
    setSessionLoading?.(false);
    setCurrentView?.('chat');

    // Brand new tab has no pending dialogs
    window.__dialogStore?.clearActive?.();

    // 文件上下文：新 tab 的状态按当前设置初始化，并让宿主把当前编辑器
    // 上下文同步到本视图（关闭时宿主回 clearSelectionInfo）。
    setContextInfo?.(null);
    sendBridgeEvent(
      'refresh_editor_context',
      JSON.stringify({ tabId: newId, enabled: newTab.autoOpenFileEnabled ?? false }),
    );

    // 同步新 Tab 标题到 IDE ToolWindow
    sendBridgeEvent('update_tab_title', newTab.title);
  }, [
    saveCurrentTabSnapshot,
    t,
    defaultAutoOpenFileEnabled,
    currentProvider,
    availableModels,
    setCurrentSessionId,
    setCustomSessionTitle,
    setMessages,
    setLoading,
    setStreamingActive,
    setIsThinking,
    setStatus,
    setRevertBoundaryId,
    setIsCompacting,
    setCompactingStartTime,
    setTaskEvents,
    setSseTodos,
    setSubagentHistories,
    setFilteredFileChanges,
    setSelectedModel,
    setPermissionMode,
    setReasoningEffort,
    setContextInfo,
    setLoadingStartTime,
    setUsagePercentage,
    setUsageUsedTokens,
    setUsageMaxTokens,
    setSessionLoading,
    setCurrentView,
    chatInputRef,
  ]);

  // Close tab
  const closeTab = useCallback(
    (tabId: string) => {
      const closingTab = tabsRef.current.find((t) => t.id === tabId);
      if (closingTab?.loading && closingTab.sessionId) {
        // Only interrupt this specific session if it was actively generating
        sendBridgeEvent('interrupt_session', JSON.stringify({ sessionId: closingTab.sessionId }));
      }
      // 新 tab 还没绑定会话时，宿主持有的是以 tabId 为键的会话（首个
      // set_model 触发补建），关闭时按同一个键释放，避免留下孤儿会话。
      const closeKey = closingTab?.sessionId ?? closingTab?.id;
      if (closeKey) {
        sendBridgeEvent('close_session', JSON.stringify({ sessionId: closeKey }));
        clearSessionSequenceBarrier(closeKey);
      }
      // Drop the archived runtime with the tab; a recycled tab id must never
      // inherit a dead session's accumulator.
      runtimeSnapshotsRef.current.delete(tabId);

      setTabs((prev) => {
        if (prev.length <= 1) {
          const defaultModel = getFirstPreferredModelId(
            currentProvider || 'opencode',
            availableModels || [],
          ) || '';
          const freshTabId = `tab-${Date.now()}`;
          const freshTab: SessionTabData = {
            id: freshTabId,
            sessionId: null,
            title: t('common.newSession', { defaultValue: '新会话' }),
            messages: [],
            isShared: false,
            autoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
            selectedModel: defaultModel,
            permissionMode: 'default',
            reasoningEffort: 'default',
            filteredFileChanges: [],
            contextInfo: null,
          };
          setActiveTabId(freshTab.id);
          setCurrentSessionId?.(null);
          setCustomSessionTitle(null);
          setMessages([]);
          setLoading?.(false);
          setStreamingActive?.(false);
          setIsThinking?.(false);
          setStatus?.('');
          setRevertBoundaryId?.(null);
          setIsCompacting?.(false);
          setCompactingStartTime?.(null);
          setTaskEvents?.({});
          setSseTodos?.(null);
          setSubagentHistories?.({});
          setFilteredFileChanges?.([]);
          if (defaultModel) {
            setSelectedModel?.(defaultModel, { sessionId: freshTabId });
          }
          setPermissionMode?.('default');
          sendBridgeEvent('set_mode', JSON.stringify({ sessionId: freshTabId, mode: 'default' }));
          setReasoningEffort?.('default');
          sendBridgeEvent(
            'set_reasoning_effort',
            JSON.stringify({ sessionId: freshTabId, reasoningEffort: 'default' }),
          );
          setLoadingStartTime?.(null);
          window.__turnStartedAt = undefined;
          setUsagePercentage?.(0);
          setUsageUsedTokens?.(undefined);
          setUsageMaxTokens?.(undefined);
          setSessionLoading?.(false);
          // Fresh tab after closing the last one: it has no draft, so the
          // closed tab's text / pending attachments must not ride along.
          const freshInput = chatInputRef?.current;
          freshInput?.setValue?.('');
          freshInput?.setAttachments?.([]);
          freshInput?.restoreFileTags?.([]);
          freshInput?.restoreQuoteTags?.({});
          // Last tab closed: the fresh tab must not inherit the dead session's
          // accumulator / turnId / message index.
          if (streamingRuntimeRefsRef.current) {
            clearStreamingRuntime(streamingRuntimeRefsRef.current);
          }
          return [freshTab];
        }

        const nextTabs = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabIdRef.current) {
          const closedIndex = prev.findIndex((t) => t.id === tabId);
          const nextActive = nextTabs[Math.max(0, closedIndex - 1)];
          if (nextActive) {
            activeTabIdRef.current = nextActive.id;
            setActiveTabId(nextActive.id);
            // Closing the active tab moves the view to a sibling: the host must
            // follow it, or the next turn is sent to the session we just closed.
            syncHostSessionTo(nextActive.sessionId);
            if (currentSessionIdRef) {
              currentSessionIdRef.current = nextActive.sessionId;
            }
            setCurrentSessionId?.(nextActive.sessionId);
            setCustomSessionTitle(nextActive.title || null);
            setMessages(nextActive.messages || []);
            restoreStreamingRuntimeFor(nextActive.id, nextActive.streamingActive);
            setLoading?.(nextActive.loading || false);
            setStreamingActive?.(nextActive.streamingActive || false);
            setIsThinking?.(nextActive.isThinking || false);
            setStatus?.(nextActive.status || '');
            setRevertBoundaryId?.(nextActive.revertBoundaryId ?? null);
            setIsCompacting?.(nextActive.isCompacting || false);
            setCompactingStartTime?.(nextActive.compactingStartTime ?? null);
            setTaskEvents?.(nextActive.taskEvents || {});
            setSseTodos?.(nextActive.sseTodos || null);
            setSubagentHistories?.(nextActive.subagentHistories || {});
            setFilteredFileChanges?.(nextActive.filteredFileChanges || []);

            const nextSessionKey = nextActive.sessionId ?? nextActive.id;
            const nextMode = nextActive.permissionMode || 'default';
            setPermissionMode?.(nextMode);
            syncPermissionModeTo(nextSessionKey, nextMode);

            const nextEffort = nextActive.reasoningEffort || 'default';
            setReasoningEffort?.(nextEffort);

            const resolvedModel = resolveSessionModel(
              nextActive.selectedModel,
              currentProvider || 'opencode',
              availableModels || [],
            );
            if (resolvedModel) {
              setSelectedModel?.(resolvedModel, { silent: true, sessionId: nextSessionKey });
            }

            // 文件上下文跟随被激活的 tab：清掉旧 chip 后由宿主补推当前文件
            setContextInfo?.(nextActive.contextInfo ?? null);
            sendBridgeEvent(
              'refresh_editor_context',
              JSON.stringify({
                tabId: nextActive.id,
                enabled: nextActive.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false),
              }),
            );

            // Restore turnStartedAt & usage tracking for the switched active tab
            const nextTurnStartedAt = nextActive.turnStartedAt ?? null;
            setLoadingStartTime?.(nextTurnStartedAt);
            window.__turnStartedAt = nextTurnStartedAt ?? undefined;

            setUsagePercentage?.(nextActive.usagePercentage ?? 0);
            setUsageUsedTokens?.(nextActive.usageUsedTokens);
            setUsageMaxTokens?.(nextActive.usageMaxTokens);

            // Closing the active tab moves the view to a sibling without going
            // through `selectTab`, so the draft has to be restored here too —
            // otherwise the closed tab's text and pending attachments stay put.
            const siblingInput = chatInputRef?.current;
            siblingInput?.setValue?.(nextActive.draft?.text ?? '');
            siblingInput?.setAttachments?.(nextActive.draft?.attachments ?? []);
            siblingInput?.restoreFileTags?.(nextActive.draft?.fileTags ?? []);
            siblingInput?.restoreQuoteTags?.(nextActive.draft?.quotes ?? {});

            setSessionLoading?.(false);

            if (window.__dialogStore) {
              window.__dialogStore.restore(
                nextActive.pendingPermissions || [],
                nextActive.pendingQuestions || []
              );
            }
          }
        }
        return nextTabs;
      });
    },
    [
      t,
      defaultAutoOpenFileEnabled,
      currentProvider,
      availableModels,
      setCurrentSessionId,
      setCustomSessionTitle,
      setMessages,
      setLoading,
      setStreamingActive,
      setIsThinking,
      setStatus,
      setRevertBoundaryId,
      setIsCompacting,
      setCompactingStartTime,
      setTaskEvents,
      setSseTodos,
      setSubagentHistories,
      setFilteredFileChanges,
      setPermissionMode,
      setReasoningEffort,
      setSelectedModel,
      setContextInfo,
      setLoadingStartTime,
      setUsagePercentage,
      setUsageUsedTokens,
      setUsageMaxTokens,
      setSessionLoading,
    ]
  );

  // Keep closeTabRef updated
  useEffect(() => {
    closeTabRef.current = closeTab;
  }, [closeTab]);

  // Keep selectTabRef updated
  useEffect(() => {
    selectTabRef.current = selectTab;
  }, [selectTab]);

  // Rename tab
  const renameTab = useCallback(
    (tabId: string, newTitle: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, title: newTitle, isCustomTitle: true } : t))
      );
      if (tabId === activeTabIdRef.current) {
        setCustomSessionTitle(newTitle);
        if (currentSessionId) {
          updateHistoryTitle(currentSessionId, newTitle);
        }
      } else {
        const target = tabsRef.current.find((t) => t.id === tabId);
        if (target?.sessionId) {
          updateHistoryTitle(target.sessionId, newTitle);
        }
      }
    },
    [currentSessionId, setCustomSessionTitle, updateHistoryTitle]
  );

  // Fork tab
  const forkTab = useCallback(
    (tab: SessionTabData) => {
      if (tab.sessionId) {
        sendBridgeEvent('fork_session', JSON.stringify({ sessionId: tab.sessionId, type: 'full' }));
      }
    },
    []
  );

  // Expose window.createSessionTab for the host's "new tab" entry point (+)
  useEffect(() => {
    (window as any).createSessionTab = createTab;
    return () => {
      delete (window as any).createSessionTab;
    };
  }, [createTab]);

  /**
   * 标签栏跨视图同步。
   *
   * 单实例之后标签是**全局状态**：任何一个窗口的新建 / 关闭 / 改名 / 激活切换
   * 都必须让其余窗口看到同一份列表，否则各窗口会各自停在不同的会话上，而
   * 宿主只有一个「当前会话」——消息会流进其中一个窗口，另一个停在旧内容。
   *
   * 上行只带结构性字段：消息与流式运行时仍由各视图本地持有，靠会话广播
   * （updateMessages / onContentDelta）自然收敛；把整包消息反复广播给 N 个
   * 视图会带来 N 份快照与 N 次重渲染。
   */
  const tabsSyncedRef = useRef(false);
  const lastSentTabsSignatureRef = useRef<string | null>(null);

  const tabsSignature = useCallback(
    (list: SessionTabData[], activeId: string) => JSON.stringify({
      activeTabId: activeId,
      tabs: list.map(toSyncedTabRecord),
    }),
    [],
  );

  useEffect(() => {
    if (!tabsSyncedRef.current) {
      return;
    }
    const signature = tabsSignature(tabs, activeTabId);
    if (signature === lastSentTabsSignatureRef.current) {
      return;
    }
    lastSentTabsSignatureRef.current = signature;
    sendBridgeEvent('sync_tabs', JSON.stringify({
      activeTabId,
      tabs: tabs.map(toSyncedTabRecord),
    }));
  }, [tabs, activeTabId, tabsSignature]);

  // 最近一次渲染的文案 / 默认值 / 绑定回调，供挂载期注册的 apply_tabs 使用。
  // 用 ref 而不是依赖：apply_tabs 只在挂载时注册一次，重复注册会重复握手。
  const tRef = useRef(t);
  tRef.current = t;
  const defaultAutoOpenFileRef = useRef(defaultAutoOpenFileEnabled);
  defaultAutoOpenFileRef.current = defaultAutoOpenFileEnabled;
  const setCurrentSessionIdRef = useRef(setCurrentSessionId);
  setCurrentSessionIdRef.current = setCurrentSessionId;
  const sessionIdRefSlot = useRef(currentSessionIdRef);
  sessionIdRefSlot.current = currentSessionIdRef;

  useEffect(() => {
    const applyTabs = (json: string) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return;
      }
      const records: SyncedTabRecord[] = Array.isArray(parsed.tabs)
        ? parsed.tabs.map(toSyncedTabRecordFromUnknown).filter((r): r is SyncedTabRecord => r !== null)
        : [];

      // 宿主没有存档（首次启动 / 刚清空）：把本视图的本地标签作为种子上行。
      if (records.length === 0) {
        tabsSyncedRef.current = true;
        lastSentTabsSignatureRef.current = null;
        return;
      }

      const merged: SessionTabData[] = records.map((record) => {
        const local = tabsRef.current.find((tab) => tab.id === record.id);
        if (local) {
          // 只覆盖结构字段：消息、流式状态、输入草稿属于本视图的运行时。
          return {
            ...local,
            sessionId: record.sessionId,
            title: record.title || local.title,
            isCustomTitle: record.isCustomTitle,
            isShared: record.isShared,
            autoOpenFileEnabled: record.autoOpenFileEnabled ?? local.autoOpenFileEnabled,
          };
        }
        return makeTabFromRecord(record, tRef.current, defaultAutoOpenFileRef.current ?? false);
      });

      const requestedActive = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null;
      const nextActiveId = merged.some((tab) => tab.id === requestedActive)
        ? requestedActive as string
        : merged[0].id;

      tabsRef.current = merged;
      setTabs(merged);
      tabsSyncedRef.current = true;
      // 先对齐签名，避免这次远端应用又触发一轮上行回声。
      lastSentTabsSignatureRef.current = tabsSignature(merged, nextActiveId);

      if (nextActiveId !== activeTabIdRef.current) {
        // 远端发起的切换：宿主已经是目标会话，不再重复下发 switch_session。
        selectTabRef.current(nextActiveId, { remote: true });
        const target = merged.find((tab) => tab.id === nextActiveId);
        if (target?.sessionId && !target.streamingActive && (target.messages?.length ?? 0) === 0) {
          // 这个标签是别的窗口刚建的，本视图还没有它的转录。
          sendBridgeEvent('request_session_snapshot', '');
        }
      } else {
        // 同一个标签，但绑定变了：另一个窗口给这个草稿发出了第一条消息。
        // 不跟随的话，本视图仍以为自己在「未绑定」状态，后续发送会另起会话。
        const activeRecord = merged.find((tab) => tab.id === nextActiveId);
        const localSessionId = sessionIdRefSlot.current?.current ?? null;
        if (activeRecord && activeRecord.sessionId !== localSessionId) {
          if (sessionIdRefSlot.current) {
            sessionIdRefSlot.current.current = activeRecord.sessionId;
          }
          setCurrentSessionIdRef.current?.(activeRecord.sessionId);
        }
      }
    };

    window.apply_tabs = applyTabs;
    // 视图挂载前另一个窗口可能已经同步过标签，宿主广播的那一包落在占位里。
    if (window.__pendingTabs) {
      const pending = window.__pendingTabs;
      window.__pendingTabs = undefined;
      applyTabs(pending);
    }
    sendBridgeEvent('get_tabs', '');
    return () => {
      delete window.apply_tabs;
    };
  }, [tabsSignature]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabAutoOpenFileEnabled = activeTab?.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false);

  const setActiveTabAutoOpenFileEnabled = useCallback((enabled: boolean) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabIdRef.current) {
          return { ...tab, autoOpenFileEnabled: enabled };
        }
        return tab;
      })
    );
    sendBridgeEvent('refresh_editor_context', JSON.stringify({ tabId: activeTabIdRef.current, enabled }));
  }, []);

  // Reorder tabs (supports long-press drag and drop reordering)
  const reorderTabs = useCallback((sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    setTabs((prev) => {
      if (sourceIndex < 0 || sourceIndex >= prev.length || targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  return {
    tabs,
    activeTabId,
    selectTab,
    createTab,
    closeTab,
    renameTab,
    forkTab,
    reorderTabs,
    openSessionInTab,
    activeTabAutoOpenFileEnabled,
    setActiveTabAutoOpenFileEnabled,
  };
}
