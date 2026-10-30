import { useCallback, useEffect, useRef } from 'react';
import type { SessionTabData } from '../../components/ChatHeader/types';
import { createTabId } from '../../store/tabStore';
import { TabMessageStore } from '../../store/tabMessageStore';
import type { TabDraftStore } from '../../store/tabDraftStore';
import type { PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { resolveSessionModel } from '../../components/ChatInputBox/modelSelectUtils';
import { sendHostCommand, sendTabCommand, cardDebugLog } from '../../utils/bridge';
import { observeHostEpoch, resetHostDispatcherEpochs } from '../../utils/hostDispatcher';
import { hostEventHandler, registerHostEvents, unregisterHostEvents } from '../../utils/hostEventRegistry';
import { getViewId, setPromptHostViewId } from '../../utils/viewIdentity';
import { endTransition, transitionTargetFor } from '../windowCallbacks/tabTransition';
import type { UseSessionTabsOptions } from './types';
import type { useTabBarState } from './useTabBarState';

export interface UseTabSessionBinderOptions extends Pick<
  UseSessionTabsOptions,
  | 'currentProvider'
  | 'availableModels'
  | 'defaultAutoOpenFileEnabled'
  | 't'
  | 'setCurrentSessionId'
  | 'setCustomSessionTitle'
  | 'setMessages'
  | 'restoreScrollState'
  | 'captureScrollState'
  | 'setLoading'
  | 'setStreamingActive'
  | 'setIsThinking'
  | 'setStatus'
  | 'setRevertBoundaryId'
  | 'setIsCompacting'
  | 'setCompactingStartTime'
  | 'setTaskEvents'
  | 'setSseTodos'
  | 'subagentHistories'
  | 'setSubagentHistories'
  | 'setFilteredFileChanges'
  | 'setSelectedModel'
  | 'setPermissionMode'
  | 'setReasoningEffort'
  | 'setContextInfo'
  | 'setLoadingStartTime'
  | 'setUsagePercentage'
  | 'setUsageUsedTokens'
  | 'setUsageMaxTokens'
  | 'setSessionLoading'
  | 'setCurrentView'
  | 'chatInputRef'
  | 'loadHistorySession'
  | 'deleteTabRuntime'
  | 'setTabRuntimeStreaming'
  | 'currentSessionIdRef'
  | 'messages'
  | 'currentSessionId'
  | 'sessionTitle'
  | 'loading'
  | 'streamingActive'
  | 'isThinking'
  | 'status'
  | 'revertBoundaryId'
  | 'isCompacting'
  | 'compactingStartTime'
  | 'taskEvents'
  | 'sseTodos'
  | 'filteredFileChanges'
  | 'permissionMode'
  | 'selectedModel'
  | 'reasoningEffort'
  | 'contextInfo'
  | 'loadingStartTime'
  | 'usagePercentage'
  | 'usageUsedTokens'
  | 'usageMaxTokens'
> {
  tabBar: ReturnType<typeof useTabBarState>;
  draftStore: TabDraftStore;
}

export function useTabSessionBinder(options: UseTabSessionBinderOptions) {
  const {
    currentProvider,
    availableModels,
    defaultAutoOpenFileEnabled,
    t,
    setCurrentSessionId,
    setCustomSessionTitle,
    setMessages,
    restoreScrollState,
    captureScrollState,
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
    loadHistorySession,
    deleteTabRuntime,
    setTabRuntimeStreaming,
    currentSessionIdRef,
    messages,
    currentSessionId,
    sessionTitle,
    revertBoundaryId,
    taskEvents,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
    loadingStartTime,
    loading,
    streamingActive,
    isThinking,
    status,
    isCompacting,
    compactingStartTime,
    subagentHistories,
    sseTodos,
    tabBar,
    draftStore,
  } = options;

  const {
    tabsRef,
    activeTabIdRef,
    setTabs,
    setActiveTabId,
  } = tabBar;

  const historyLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (historyLoadingTimeoutRef.current) {
        clearTimeout(historyLoadingTimeoutRef.current);
      }
    };
  }, []);

  const runtimeStateRef = useRef({
    messages,
    currentSessionId,
    sessionTitle,
    revertBoundaryId,
    taskEvents,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
    loadingStartTime,
    loading,
    streamingActive,
    isThinking,
    status,
    isCompacting,
    compactingStartTime,
    subagentHistories,
    sseTodos,
  });

  useEffect(() => {
    runtimeStateRef.current = {
      messages,
      currentSessionId,
      sessionTitle,
      revertBoundaryId,
      taskEvents,
      filteredFileChanges,
      permissionMode,
      selectedModel,
      reasoningEffort,
      contextInfo,
      usagePercentage,
      usageUsedTokens,
      usageMaxTokens,
      loadingStartTime,
      loading,
      streamingActive,
      isThinking,
      status,
      isCompacting,
      compactingStartTime,
      subagentHistories,
      sseTodos,
    };
  }, [
    messages,
    currentSessionId,
    sessionTitle,
    revertBoundaryId,
    taskEvents,
    filteredFileChanges,
    permissionMode,
    selectedModel,
    reasoningEffort,
    contextInfo,
    usagePercentage,
    usageUsedTokens,
    usageMaxTokens,
    loadingStartTime,
    loading,
    streamingActive,
    isThinking,
    status,
    isCompacting,
    compactingStartTime,
    subagentHistories,
    sseTodos,
  ]);

  const syncHostActiveTabTo = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return;
    sendTabCommand(tabId, 'tab.activate');
  }, []);

  const syncPermissionModeTo = useCallback(
    (tabId: string | null | undefined, sessionId: string | null | undefined, mode: string) => {
      if (!tabId || !sessionId) return;
      sendHostCommand(tabId, 'settings.mode', { mode }, sessionId);
    },
    [],
  );

  useEffect(() => {
    const resync = (raw: string | unknown) => {
      let payload: {
        type?: string;
        activeTabId?: string;
        tabs?: Array<{
          tabId?: string;
          sessionId?: string | null;
          title?: string;
          streaming?: boolean;
          loading?: boolean;
          epoch?: number;
          draft?: string;
        }>;
      };
      try {
        payload = typeof raw === 'string' ? JSON.parse(raw) as typeof payload : (raw as typeof payload);
      } catch (error) {
        cardDebugLog('[SessionTabs] onTabResync: invalid payload', error);
        return;
      }
      cardDebugLog('[SessionTabs] onTabResync applied tabs count:', payload?.tabs?.length, 'active:', payload?.activeTabId);
      const incoming = (payload?.tabs ?? []).filter(
        (entry): entry is NonNullable<typeof entry> =>
          !!entry && typeof entry.tabId === 'string' && entry.tabId.length > 0,
      );
      if (incoming.length === 0) return;

      resetHostDispatcherEpochs();
      for (const entry of incoming) {
        if (typeof entry.epoch === 'number') {
          observeHostEpoch(entry.tabId!, entry.epoch);
        }
      }

      const previousById = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
      const nextTabs: SessionTabData[] = incoming.map((entry) => {
        const previous = previousById.get(entry.tabId!);
        const sessionId = typeof entry.sessionId === 'string' && entry.sessionId
          ? entry.sessionId
          : (previous?.sessionId ?? null);
        const title = entry.title || previous?.title
          || t('common.newSession', { defaultValue: '新会话' });
        const streamingActive = typeof entry.streaming === 'boolean'
          ? entry.streaming
          : (previous?.streamingActive ?? false);
        const loading = typeof entry.loading === 'boolean'
          ? entry.loading
          : (previous?.loading ?? false);
        if (typeof entry.draft === 'string') {
          const previousDraft = draftStore.get(entry.tabId!);
          draftStore.set(entry.tabId!, {
            text: entry.draft,
            attachments: previousDraft?.attachments ?? [],
            fileTags: previousDraft?.fileTags ?? [],
            quotes: previousDraft?.quotes ?? {},
          });
        }
        if (previous) {
          return { ...previous, sessionId, title, streamingActive, loading };
        }
        return {
          id: entry.tabId!,
          sessionId,
          title,
          messageStore: new TabMessageStore(),
          messages: [],
          isShared: false,
          loading,
          streamingActive,
          permissionMode: 'default',
          reasoningEffort: 'default',
          filteredFileChanges: [],
          contextInfo: null,
          pendingPermissions: [],
          pendingQuestions: [],
        };
      });

      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      const liveIds = new Set(nextTabs.map((tab) => tab.id));
      for (const previousId of previousById.keys()) {
        if (liveIds.has(previousId)) continue;
        deleteTabRuntime?.(previousId);
        draftStore.delete(previousId);
      }

      const targetId = typeof payload.activeTabId === 'string'
        ? payload.activeTabId
        : nextTabs[0].id;
      const target = nextTabs.find((tab) => tab.id === targetId) ?? nextTabs[0];
      if (!target) return;
      activeTabIdRef.current = target.id;
      setActiveTabId(target.id);
      if (currentSessionIdRef) {
        currentSessionIdRef.current = target.sessionId;
      }
      setCurrentSessionId?.(target.sessionId);
      setCustomSessionTitle(target.title || null);
      // Restore the host-held draft after a view rebuild (drafts sync across
      // views, but a fresh webview has no local draft store yet).
      const targetDraft = draftStore.get(target.id)?.text ?? '';
      if (targetDraft) {
        window.setTimeout(() => chatInputRef?.current?.setValue?.(targetDraft), 0);
      }
    };

    registerHostEvents({ 'tab.resync': resync });
    return () => {
      if (hostEventHandler('tab.resync') === resync) {
        unregisterHostEvents(['tab.resync']);
      }
    };
  }, [
    setCurrentSessionId,
    setCustomSessionTitle,
    t,
    deleteTabRuntime,
    draftStore,
    tabsRef,
    setTabs,
    activeTabIdRef,
    setActiveTabId,
    currentSessionIdRef,
    chatInputRef,
  ]);

  const saveCurrentTabSnapshot = useCallback(() => {
    const currentActive = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (currentActive) {
      const snap = runtimeStateRef.current;
      // The transcript and turn state are already owned by this tab; copying
      // them back from a React snapshot could overwrite a newer background
      // update with a value captured before it. Only window-level state is
      // snapshotted here.
      currentActive.sessionId = snap.currentSessionId;
      const isDefaultSnapTitle = !snap.sessionTitle || snap.sessionTitle === t('common.newSession');
      currentActive.title = isDefaultSnapTitle ? currentActive.title : (snap.sessionTitle || currentActive.title);
      currentActive.revertBoundaryId = snap.revertBoundaryId;
      currentActive.taskEvents = snap.taskEvents;
      currentActive.filteredFileChanges = snap.filteredFileChanges;
      currentActive.permissionMode = snap.permissionMode;
      currentActive.selectedModel = snap.selectedModel;
      currentActive.reasoningEffort = snap.reasoningEffort;
      currentActive.contextInfo = snap.contextInfo;
      currentActive.usagePercentage = snap.usagePercentage;
      currentActive.usageUsedTokens = snap.usageUsedTokens;
      currentActive.usageMaxTokens = snap.usageMaxTokens;
      // Turn/stream state is per tab and lives in the tab record now (the old
      // TabStatusStore snapshot exchange is gone). Mirroring the active view's
      // React projection here is a write, not a second source: the record is
      // the only store that survives a switch, and background events only
      // touch records of tabs that are not active in this view.
      currentActive.loading = snap.loading;
      currentActive.streamingActive = snap.streamingActive;
      currentActive.isThinking = snap.isThinking;
      currentActive.status = snap.status;
      currentActive.isCompacting = snap.isCompacting;
      currentActive.compactingStartTime = snap.compactingStartTime;
      currentActive.subagentHistories = snap.subagentHistories;
      currentActive.sseTodos = snap.sseTodos;
      currentActive.messageBaseIndex = typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : currentActive.messageBaseIndex;
      currentActive.opencodeListStart = typeof window.__opencodeListStart === 'number' ? window.__opencodeListStart : currentActive.opencodeListStart;
      currentActive.prependedHistoryMessageCount = typeof window.__prependedHistoryMessageCount === 'number' ? window.__prependedHistoryMessageCount : currentActive.prependedHistoryMessageCount;
      const capturedScroll = captureScrollState?.();
      if (capturedScroll) {
        currentActive.scrollState = capturedScroll;
      }

      const currentDraftText = chatInputRef?.current?.getValue?.() ?? '';
      draftStore.set(currentActive.id, {
        text: currentDraftText,
        attachments: chatInputRef?.current?.getAttachments?.() ?? [],
        fileTags: chatInputRef?.current?.getFileTags?.() ?? [],
        quotes: chatInputRef?.current?.getQuotes?.() ?? {},
      });
    }
  }, [
    tabsRef,
    activeTabIdRef,
    t,
    captureScrollState,
    chatInputRef,
    draftStore,
  ]);

  const selectTab = useCallback(
    (targetTabId: string, selectOptions?: { fromHost?: boolean }) => {
      const fromHost = selectOptions?.fromHost === true;
      if (targetTabId === activeTabIdRef.current) return;

      saveCurrentTabSnapshot();

      const targetTab = tabsRef.current.find((t) => t.id === targetTabId);
      if (!targetTab) return;

      activeTabIdRef.current = targetTabId;
      setActiveTabId(targetTabId);

      const pendingTransitionTarget = transitionTargetFor(targetTabId);
      if (
        pendingTransitionTarget
        && pendingTransitionTarget !== targetTab.sessionId
      ) {
        endTransition(targetTabId);
      }

      if (!fromHost) {
        syncHostActiveTabTo(targetTab.id);
      }

      if (currentSessionIdRef) {
        currentSessionIdRef.current = targetTab.sessionId;
      }
      setCurrentSessionId?.(targetTab.sessionId);
      setCustomSessionTitle(targetTab.title || null);
      restoreScrollState?.(targetTab.scrollState ?? null);
      setMessages?.(targetTab.messages ?? []);

      // Turn state, transcript and subagent histories belong to the target tab.
      // The tab record is authoritative; no status snapshot is exchanged.
      if (targetTab.streamingActive) {
        setTabRuntimeStreaming?.(targetTab.id, true);
      }
      setLoading?.(targetTab.loading ?? false);
      setStreamingActive?.(targetTab.streamingActive ?? false);
      setIsThinking?.(targetTab.isThinking ?? false);
      setStatus?.(targetTab.status ?? '');
      setRevertBoundaryId?.(targetTab.revertBoundaryId ?? null);
      setTaskEvents?.(targetTab.taskEvents ?? {});
      setSseTodos?.(targetTab.sseTodos ?? null);
      setSubagentHistories?.(targetTab.subagentHistories ?? {});
      setFilteredFileChanges?.(targetTab.filteredFileChanges ?? []);

      window.__messageBaseIndex = targetTab.messageBaseIndex ?? 0;
      window.__opencodeListStart = targetTab.opencodeListStart ?? 0;
      window.__prependedHistoryMessageCount = targetTab.prependedHistoryMessageCount ?? 0;

      const targetMode = targetTab.permissionMode || 'default';
      setPermissionMode?.(targetMode);
      if (!fromHost) {
        syncPermissionModeTo(targetTab.id, targetTab.sessionId, targetMode);
      }

      const targetEffort = targetTab.reasoningEffort || 'default';
      setReasoningEffort?.(targetEffort);

      const resolvedModel = resolveSessionModel(
        targetTab.selectedModel,
        currentProvider || 'opencode',
        availableModels || [],
      );
      if (resolvedModel) {
        setSelectedModel?.(resolvedModel, { silent: true });
      }

      const isAutoOpen = targetTab.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false);
      if (!fromHost) {
        sendHostCommand(targetTab.id, 'context.refresh', { enabled: isAutoOpen });
      }
      if (targetTab.contextInfo) {
        setContextInfo?.(targetTab.contextInfo);
      }

      const targetTurnStartedAt = targetTab.turnStartedAt ?? null;
      setLoadingStartTime?.(targetTurnStartedAt);
      window.__turnStartedAt = targetTurnStartedAt ?? undefined;

      setUsagePercentage?.(targetTab.usagePercentage ?? 0);
      setUsageUsedTokens?.(targetTab.usageUsedTokens);
      setUsageMaxTokens?.(targetTab.usageMaxTokens);

      if (chatInputRef?.current?.setValue) {
        const draft = draftStore.get(targetTab.id);
        chatInputRef.current.setValue(draft?.text ?? '');
        chatInputRef.current.setAttachments?.(draft?.attachments ?? []);
        chatInputRef.current.restoreFileTags?.(draft?.fileTags ?? []);
        chatInputRef.current.restoreQuoteTags?.(draft?.quotes ?? {});
      }

      setSessionLoading?.(false);
    },
    [
      activeTabIdRef,
      saveCurrentTabSnapshot,
      tabsRef,
      setActiveTabId,
      syncHostActiveTabTo,
      currentSessionIdRef,
      setCurrentSessionId,
      setCustomSessionTitle,
      restoreScrollState,
      setMessages,
      setLoading,
      setStreamingActive,
      setIsThinking,
      setStatus,
      setSseTodos,
      setSubagentHistories,
      setLoadingStartTime,
      setTabRuntimeStreaming,
      setRevertBoundaryId,
      setTaskEvents,
      setFilteredFileChanges,
      setPermissionMode,
      syncPermissionModeTo,
      setReasoningEffort,
      currentProvider,
      availableModels,
      setSelectedModel,
      defaultAutoOpenFileEnabled,
      setContextInfo,
      setUsagePercentage,
      setUsageUsedTokens,
      setUsageMaxTokens,
      chatInputRef,
      draftStore,
      setSessionLoading,
    ]
  );

  // ── Host-driven tab sync (multi-view) ─────────────────────────────────
  // Every view receives the same tab lifecycle events. The host is the single
  // authority for which tab is active and in what order, so a view that is not
  // the initiator follows without writing back (no echo loop).
  useEffect(() => {
    const onCreated = (payload: { tabId?: string; title?: string }) => {
      const tabId = payload?.tabId;
      if (!tabId || tabsRef.current.some((tab) => tab.id === tabId)) {
        return;
      }
      const tab: SessionTabData = {
        id: tabId,
        sessionId: null,
        messageStore: new TabMessageStore(),
        title: payload.title || t('common.newSession', { defaultValue: '新会话' }),
        messages: [],
        isShared: false,
        loading: false,
        streamingActive: false,
        permissionMode: 'default',
        reasoningEffort: 'default',
        filteredFileChanges: [],
        contextInfo: null,
        pendingPermissions: [],
        pendingQuestions: [],
      };
      const next = [...tabsRef.current, tab];
      tabsRef.current = next;
      setTabs(next);
    };

    const onClosed = (payload: { tabId?: string }) => {
      const tabId = payload?.tabId;
      if (!tabId) {
        return;
      }
      const next = tabsRef.current.filter((tab) => tab.id !== tabId);
      if (next.length === tabsRef.current.length) {
        return;
      }
      tabsRef.current = next;
      setTabs(next);
      draftStore.delete(tabId);
      if (activeTabIdRef.current === tabId) {
        // Do NOT pick a neighbour here: the next active tab is the initiating
        // view's decision, announced by its `tab.activate` (the host only
        // deletes on `tab.close` and broadcasts whatever that view asks for).
        // Pre-selecting one would fight that broadcast with a local guess.
        activeTabIdRef.current = '';
        setActiveTabId('');
      }
    };

    const onActivated = (payload: { tabId?: string }) => {
      const tabId = payload?.tabId;
      if (!tabId || tabId === activeTabIdRef.current) {
        return;
      }
      if (!tabsRef.current.some((tab) => tab.id === tabId)) {
        // Defensive: if `tab.created` was missed, add the identity only. The
        // host replays the full snapshot right after the activation.
        const tab: SessionTabData = {
          id: tabId,
          sessionId: null,
          messageStore: new TabMessageStore(),
          title: t('common.newSession', { defaultValue: '新会话' }),
          messages: [],
          isShared: false,
          loading: false,
          streamingActive: false,
          permissionMode: 'default',
          reasoningEffort: 'default',
          filteredFileChanges: [],
          contextInfo: null,
          pendingPermissions: [],
          pendingQuestions: [],
        };
        const next = [...tabsRef.current, tab];
        tabsRef.current = next;
        setTabs(next);
      }
      selectTab(tabId, { fromHost: true });
    };

    const onReordered = (payload: { tabIds?: string[] }) => {
      const ids = Array.isArray(payload?.tabIds)
        ? payload.tabIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (ids.length === 0) {
        return;
      }
      const byId = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
      const ordered: SessionTabData[] = [];
      for (const id of ids) {
        const tab = byId.get(id);
        if (tab) {
          ordered.push(tab);
          byId.delete(id);
        }
      }
      for (const tab of tabsRef.current) {
        if (byId.has(tab.id)) {
          ordered.push(tab);
          byId.delete(tab.id);
        }
      }
      tabsRef.current = ordered;
      setTabs(ordered);
    };

    const onDraftChanged = (payload: {
      tabId?: string;
      draft?: string;
      sourceViewId?: string;
    }) => {
      const tabId = payload?.tabId;
      const draft = payload?.draft;
      if (!tabId || typeof draft !== 'string') {
        return;
      }
      // 发送方忽略自己的回声，避免输入过程中光标被重置。
      if (payload.sourceViewId && payload.sourceViewId === getViewId()) {
        return;
      }
      const previous = draftStore.get(tabId);
      draftStore.set(tabId, {
        text: draft,
        attachments: previous?.attachments ?? [],
        fileTags: previous?.fileTags ?? [],
        quotes: previous?.quotes ?? {},
      });
      if (tabId === activeTabIdRef.current) {
        chatInputRef?.current?.setValue?.(draft);
      }
    };

    const onPromptHostChanged = (payload: { viewId?: string }) => {
      setPromptHostViewId(
        typeof payload?.viewId === 'string' && payload.viewId ? payload.viewId : null,
      );
    };

    const onViewNavigate = (payload: { view?: string; sourceViewId?: string }) => {
      if (payload?.sourceViewId && payload.sourceViewId === getViewId()) {
        return;
      }
      const view = payload?.view;
      if (view === 'chat' || view === 'history' || view === 'settings') {
        setCurrentView?.(view);
      }
    };

    const handlers = {
      'tab.created': onCreated,
      'tab.closed': onClosed,
      'tab.activated': onActivated,
      'tab.reordered': onReordered,
      'tab.draft.changed': onDraftChanged,
      'prompt.host.changed': onPromptHostChanged,
      'view.navigate': onViewNavigate,
    };
    registerHostEvents(handlers);
    return () => {
      for (const [type, handler] of Object.entries(handlers)) {
        if (hostEventHandler(type) === handler) {
          unregisterHostEvents([type]);
        }
      }
    };
  }, [
    tabsRef,
    setTabs,
    activeTabIdRef,
    setActiveTabId,
    selectTab,
    draftStore,
    chatInputRef,
    setCurrentView,
    t,
  ]);

  const openSessionInTab = useCallback(
    (
      sessionId: string,
      title?: string,
      historyModel?: string,
      historyMode?: string,
      historyEffort?: string,
      reservedTabId?: string
    ) => {
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

      const currentActive = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const isCurrentEmptyDraft =
        currentActive &&
        currentActive.sessionId === null &&
        (!messages || messages.length === 0) &&
        (!currentActive.messages || currentActive.messages.length === 0);

      const resolvedTitle = title || t('common.historySession', { defaultValue: '历史会话' });

      if (isCurrentEmptyDraft && currentActive && (!reservedTabId || reservedTabId === currentActive.id)) {
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
                compactNotice: null,
                scrollState: undefined,
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
        saveCurrentTabSnapshot();

        const newId = reservedTabId ?? createTabId();
        // A reserved fork tab may already exist because the host bound it and
        // another event (tab.created) arrived first. Reuse it instead of
        // appending a second tab with the same id.
        const reservedTab = reservedTabId
          ? tabsRef.current.find((tab) => tab.id === reservedTabId)
          : undefined;
        if (!reservedTab) {
          sendTabCommand(newId, 'tab.create');
        }
        const newTab: SessionTabData = {
          ...(reservedTab ?? {}),
          id: newId,
          sessionId,
          messageStore: reservedTab?.messageStore ?? new TabMessageStore(),
          title: resolvedTitle,
          messages: reservedTab?.messages ?? [],
          isShared: false,
          loading: false,
          streamingActive: false,
          pendingPermissions: [],
          pendingQuestions: [],
          autoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
          selectedModel: resolvedModel,
          permissionMode: resolvedMode,
          reasoningEffort: resolvedEffort,
          filteredFileChanges: [],
          contextInfo: null,
        };

        const updatedTabs = reservedTab
          ? tabsRef.current.map((tab) => (tab.id === newId ? newTab : tab))
          : [...tabsRef.current, newTab];
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

      syncHostActiveTabTo(activeTabIdRef.current);

      setMessages([]);
      restoreScrollState?.(null);
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

      if (resolvedModel) {
        setSelectedModel?.(resolvedModel, { silent: true });
      }
      setPermissionMode?.(resolvedMode);
      syncPermissionModeTo(activeTabIdRef.current, sessionId, resolvedMode);
      setReasoningEffort?.(resolvedEffort);

      setLoadingStartTime?.(null);
      window.__turnStartedAt = undefined;
      setUsagePercentage?.(0);
      setUsageUsedTokens?.(undefined);
      setUsageMaxTokens?.(undefined);

      chatInputRef?.current?.setValue?.('');
      setCurrentView?.('chat');
      setSessionLoading?.(true);

      if (historyLoadingTimeoutRef.current) {
        clearTimeout(historyLoadingTimeoutRef.current);
      }
      historyLoadingTimeoutRef.current = setTimeout(() => {
        setSessionLoading?.(false);
      }, 8000);

      if (loadHistorySession) {
        // The tab prepared above owns this bind. Passing it is what keeps the
        // (already updated) currentSessionId from turning the bind into a
        // "same session" soft reload that never hydrates the tab.
        loadHistorySession(sessionId, activeTabIdRef.current);
      } else {
        sendHostCommand(activeTabIdRef.current, 'session.load', { sessionId, title: resolvedTitle }, sessionId);
      }
    },
    [
      tabsRef,
      selectTab,
      setCurrentView,
      setSessionLoading,
      currentProvider,
      availableModels,
      activeTabIdRef,
      messages,
      t,
      defaultAutoOpenFileEnabled,
      setTabs,
      currentSessionIdRef,
      setCurrentSessionId,
      setCustomSessionTitle,
      saveCurrentTabSnapshot,
      setActiveTabId,
      syncHostActiveTabTo,
      setMessages,
      restoreScrollState,
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
      syncPermissionModeTo,
      setReasoningEffort,
      setLoadingStartTime,
      setUsagePercentage,
      setUsageUsedTokens,
      setUsageMaxTokens,
      chatInputRef,
      loadHistorySession,
    ]
  );

  return {
    syncHostActiveTabTo,
    syncPermissionModeTo,
    saveCurrentTabSnapshot,
    selectTab,
    openSessionInTab,
  };
}
