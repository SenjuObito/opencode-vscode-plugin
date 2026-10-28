import { useCallback, useEffect, useRef } from 'react';
import type { SessionTabData } from '../../components/ChatHeader/types';
import { createTabId } from '../../store/tabStore';
import { TabMessageStore } from '../../store/tabMessageStore';
import type { TabDraftStore } from '../../store/tabDraftStore';
import type { TabStatusStore } from '../../store/tabStatusStore';
import { statusSnapshotOf } from '../../store/tabStatusStore';
import type { TabPromptStore } from '../../store/tabPromptStore';
import type { PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { resolveSessionModel } from '../../components/ChatInputBox/modelSelectUtils';
import { sendSessionCommand, sendHostCommand, sendTabCommand, cardDebugLog } from '../../utils/bridge';
import { observeHostEpoch, resetHostDispatcherEpochs } from '../../utils/hostDispatcher';
import { hostEventHandler, registerHostEvents, unregisterHostEvents } from '../../utils/hostEventRegistry';
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
  statusStore: TabStatusStore;
  promptStore: TabPromptStore;
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
    tabBar,
    draftStore,
    statusStore,
    promptStore,
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
  ]);

  const syncHostActiveTabTo = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return;
    sendTabCommand(tabId, 'tab.activate');
  }, []);

  const syncPermissionModeTo = useCallback(
    (sessionId: string | null | undefined, mode: string) => {
      if (!sessionId) return;
      sendSessionCommand('settings.mode', sessionId, { mode });
    },
    [],
  );

  useEffect(() => {
    const resync = (json: string) => {
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
        }>;
      };
      try {
        payload = JSON.parse(json) as typeof payload;
      } catch (error) {
        cardDebugLog('[SessionTabs] onTabResync: invalid payload', error);
        return;
      }
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
        statusStore.delete(previousId);
        promptStore.delete(previousId);
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
    statusStore,
    promptStore,
    tabsRef,
    setTabs,
    activeTabIdRef,
    setActiveTabId,
    currentSessionIdRef,
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
      currentActive.messageBaseIndex = typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : currentActive.messageBaseIndex;
      currentActive.opencodeListStart = typeof window.__opencodeListStart === 'number' ? window.__opencodeListStart : currentActive.opencodeListStart;
      currentActive.prependedHistoryMessageCount = typeof window.__prependedHistoryMessageCount === 'number' ? window.__prependedHistoryMessageCount : currentActive.prependedHistoryMessageCount;
      const capturedScroll = captureScrollState?.();
      if (capturedScroll) {
        currentActive.scrollState = capturedScroll;
      }

      for (const tab of tabsRef.current) {
        statusStore.set(tab.id, statusSnapshotOf(tab));
      }

      const currentDraftText = chatInputRef?.current?.getValue?.() ?? '';
      draftStore.set(currentActive.id, {
        text: currentDraftText,
        attachments: chatInputRef?.current?.getAttachments?.() ?? [],
        fileTags: chatInputRef?.current?.getFileTags?.() ?? [],
        quotes: chatInputRef?.current?.getQuotes?.() ?? {},
      });

      for (const tab of tabsRef.current) {
        if (tab.id === currentActive.id) continue;
        promptStore.set(tab.id, {
          permissions: tab.pendingPermissions ?? [],
          questions: tab.pendingQuestions ?? [],
          plans: tab.pendingPlans ?? [],
        });
      }
      if (window.__dialogStore) {
        const dialogSnap = window.__dialogStore.getSnapshot();
        promptStore.set(currentActive.id, {
          permissions: dialogSnap.permissions,
          questions: dialogSnap.questions,
          plans: currentActive.pendingPlans ?? [],
        });
        currentActive.pendingPermissions = dialogSnap.permissions;
        currentActive.pendingQuestions = dialogSnap.questions;
      }
    }
  }, [
    tabsRef,
    activeTabIdRef,
    t,
    captureScrollState,
    statusStore,
    chatInputRef,
    draftStore,
    promptStore,
  ]);

  const selectTab = useCallback(
    (targetTabId: string) => {
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

      syncHostActiveTabTo(targetTab.id);

      if (currentSessionIdRef) {
        currentSessionIdRef.current = targetTab.sessionId;
      }
      setCurrentSessionId?.(targetTab.sessionId);
      setCustomSessionTitle(targetTab.title || null);
      restoreScrollState?.(targetTab.scrollState ?? null);
      setMessages?.(targetTab.messages ?? []);

      // Turn state, transcript and subagent histories belong to the target tab.
      // Activating it is enough; copying a status-store snapshot back would let
      // a stale background snapshot clear a live stream on the newly active tab.
      const targetStatus = statusStore.get(targetTab.id);
      if (targetTab.streamingActive) {
        setTabRuntimeStreaming?.(targetTab.id, true);
      }
      const targetRevertBoundaryId = targetTab.revertBoundaryId !== undefined
        ? targetTab.revertBoundaryId
        : (targetStatus?.revertBoundaryId ?? null);
      setRevertBoundaryId?.(targetRevertBoundaryId);
      setTaskEvents?.(targetStatus?.taskEvents ?? targetTab.taskEvents ?? {});
      setFilteredFileChanges?.(targetStatus?.filteredFileChanges ?? targetTab.filteredFileChanges ?? []);

      window.__messageBaseIndex = targetTab.messageBaseIndex ?? 0;
      window.__opencodeListStart = targetTab.opencodeListStart ?? 0;
      window.__prependedHistoryMessageCount = targetTab.prependedHistoryMessageCount ?? 0;

      const targetMode = targetTab.permissionMode || 'default';
      setPermissionMode?.(targetMode);
      syncPermissionModeTo(targetTab.sessionId, targetMode);

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
      sendHostCommand(targetTab.id, 'context.refresh', { enabled: isAutoOpen });
      if (targetTab.contextInfo) {
        setContextInfo?.(targetTab.contextInfo);
      }

      window.__turnStartedAt = targetTab.turnStartedAt ?? undefined;

      setUsagePercentage?.(targetStatus?.usagePercentage ?? targetTab.usagePercentage ?? 0);
      setUsageUsedTokens?.(targetStatus ? targetStatus.usageUsedTokens : targetTab.usageUsedTokens);
      setUsageMaxTokens?.(targetStatus ? targetStatus.usageMaxTokens : targetTab.usageMaxTokens);

      if (chatInputRef?.current?.setValue) {
        const draft = draftStore.get(targetTab.id);
        chatInputRef.current.setValue(draft?.text ?? '');
        chatInputRef.current.setAttachments?.(draft?.attachments ?? []);
        chatInputRef.current.restoreFileTags?.(draft?.fileTags ?? []);
        chatInputRef.current.restoreQuoteTags?.(draft?.quotes ?? {});
      }

      setSessionLoading?.(false);

      if (window.__dialogStore) {
        const targetPrompts = promptStore.get(targetTab.id);
        window.__dialogStore.restore(
          targetPrompts?.permissions ?? targetTab.pendingPermissions ?? [],
          targetPrompts?.questions ?? targetTab.pendingQuestions ?? [],
          targetPrompts?.plans ?? targetTab.pendingPlans ?? [],
        );
      }
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
      statusStore,
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
      promptStore,
    ]
  );

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
        sendTabCommand(newId, 'tab.create');
        const newTab: SessionTabData = {
          id: newId,
          sessionId,
          messageStore: new TabMessageStore(),
          title: resolvedTitle,
          messages: [],
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
      syncPermissionModeTo(sessionId, resolvedMode);
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

      window.__dialogStore?.clearActive?.();

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
