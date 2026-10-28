import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TabType } from '../../components/StatusPanel/types';
import { getTabStore } from '../../store/tabStore';
import { TabMessageStore } from '../../store/tabMessageStore';
import type { TabDraftStore } from '../../store/tabDraftStore';
import { sendHostCommand } from '../../utils/bridge';
import type { UseSessionTabsOptions } from './types';

export interface UseTabBarStateOptions extends Pick<
  UseSessionTabsOptions,
  | 'currentSessionId'
  | 'currentSessionIdRef'
  | 'setCurrentSessionId'
  | 'sessionTitle'
  | 'setCustomSessionTitle'
  | 'updateHistoryTitle'
  | 'revertBoundaryId'
  | 'taskEvents'
  | 'filteredFileChanges'
  | 'permissionMode'
  | 'selectedModel'
  | 'reasoningEffort'
  | 'contextInfo'
  | 'usagePercentage'
  | 'usageUsedTokens'
  | 'usageMaxTokens'
  | 'isCompacting'
  | 'compactingStartTime'
  | 'isShared'
  | 'defaultAutoOpenFileEnabled'
  | 'deleteTabRuntime'
  | 't'
> {
  draftStore: TabDraftStore;
}

export function useTabBarState(options: UseTabBarStateOptions) {
  const {
    setCurrentSessionId,
    setCustomSessionTitle,
    updateHistoryTitle,
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
    isCompacting,
    compactingStartTime,
    defaultAutoOpenFileEnabled,
    deleteTabRuntime,
    t,
    draftStore,
  } = options;

  const tabStore = getTabStore();
  useState(() => {
    if (tabStore.size() === 0) {
      tabStore.setTabs([
        {
          id: 'tab-1',
          sessionId: null,
          messageStore: new TabMessageStore(),
          title: t('common.newSession', { defaultValue: '新会话' }),
          messages: [],
          isShared: false,
          autoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
          permissionMode: permissionMode || 'default',
          selectedModel: selectedModel,
          reasoningEffort: reasoningEffort || 'default',
          filteredFileChanges: [],
          contextInfo: contextInfo ?? null,
          statusPanelExpanded: true,
          statusPanelTab: null,
          turnStartedAt: null,
          usagePercentage: usagePercentage ?? 0,
          usageUsedTokens: usageUsedTokens,
          usageMaxTokens: usageMaxTokens,
        },
      ]);
      tabStore.setActiveTabId('tab-1');
    }
  });

  const tabs = useSyncExternalStore(tabStore.subscribe, tabStore.getTabs, tabStore.getTabs);
  const activeTabId = useSyncExternalStore(
    tabStore.subscribe,
    tabStore.getActiveTabId,
    tabStore.getActiveTabId,
  );
  const setTabs = tabStore.setTabs;
  const setActiveTabId = tabStore.setActiveTabId;

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Sync the fields the view owns onto the active tab (user choices: model,
  // mode, effort, usage mirrors). Binding fields are NOT mirrored here: the
  // tab's `sessionId`/`title`/`isShared` are written by their events and by
  // activation, so a stale projection can never overwrite them.
  useEffect(() => {
    setTabs((prev) => {
      const active = prev.find((t) => t.id === activeTabId);
      if (!active) return prev;

      const nextUsagePercentage = usagePercentage ?? active.usagePercentage;
      const nextUsageUsedTokens = usageUsedTokens !== undefined ? usageUsedTokens : active.usageUsedTokens;
      const nextUsageMaxTokens = usageMaxTokens !== undefined ? usageMaxTokens : active.usageMaxTokens;
      const nextMessageBaseIndex = typeof window.__messageBaseIndex === 'number' ? window.__messageBaseIndex : active.messageBaseIndex;
      const nextOpencodeListStart = typeof window.__opencodeListStart === 'number' ? window.__opencodeListStart : active.opencodeListStart;
      const nextPrepended = typeof window.__prependedHistoryMessageCount === 'number' ? window.__prependedHistoryMessageCount : active.prependedHistoryMessageCount;
      // A compact belongs to the tab that started it. Mirroring it here keeps
      // the spinner on that tab when the user switches away and back.
      const nextIsCompacting = isCompacting ?? active.isCompacting ?? false;
      const nextCompactingStartTime = compactingStartTime !== undefined
        ? compactingStartTime
        : (active.compactingStartTime ?? null);

      if (
        active.revertBoundaryId === revertBoundaryId &&
        active.taskEvents === taskEvents &&
        active.filteredFileChanges === filteredFileChanges &&
        active.permissionMode === permissionMode &&
        active.selectedModel === selectedModel &&
        active.reasoningEffort === reasoningEffort &&
        active.contextInfo === contextInfo &&
        active.usagePercentage === nextUsagePercentage &&
        active.usageUsedTokens === nextUsageUsedTokens &&
        active.usageMaxTokens === nextUsageMaxTokens &&
        active.messageBaseIndex === nextMessageBaseIndex &&
        active.opencodeListStart === nextOpencodeListStart &&
        active.prependedHistoryMessageCount === nextPrepended &&
        (active.isCompacting ?? false) === nextIsCompacting &&
        (active.compactingStartTime ?? null) === nextCompactingStartTime
      ) {
        return prev;
      }

      return prev.map((tab) => {
        if (tab.id === activeTabId) {
          return {
            ...tab,
            revertBoundaryId,
            taskEvents,
            filteredFileChanges,
            permissionMode,
            selectedModel,
            reasoningEffort,
            contextInfo,
            usagePercentage: nextUsagePercentage,
            usageUsedTokens: nextUsageUsedTokens,
            usageMaxTokens: nextUsageMaxTokens,
            messageBaseIndex: nextMessageBaseIndex,
            opencodeListStart: nextOpencodeListStart,
            prependedHistoryMessageCount: nextPrepended,
            isCompacting: nextIsCompacting,
            compactingStartTime: nextCompactingStartTime,
          };
        }
        return tab;
      });
    });
  }, [
    activeTabId,
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
    isCompacting,
    compactingStartTime,
  ]);

  const closeTabRef = useRef<(tabId: string) => void>(() => {});
  useEffect(() => {
    // The store calls back into the view for the effects of a tab change; there
    // is no window-level mirror. bindView keeps the latest closures, so an
    // update always sees the current state setters.
    tabStore.bindView({
      setCurrentSessionId,
      setCustomSessionTitle,
      deleteTabRuntime,
      closeTab: (tabId: string) => closeTabRef.current(tabId),
      getDrafts: () => draftStore.getAll(),
      defaultAutoOpenFileEnabled: defaultAutoOpenFileEnabled ?? false,
    });
  }, [
    tabStore,
    setCurrentSessionId,
    setCustomSessionTitle,
    deleteTabRuntime,
    draftStore,
    defaultAutoOpenFileEnabled,
  ]);

  const renameTab = useCallback(
    (tabId: string, newTitle: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, title: newTitle, isCustomTitle: true } : t))
      );
      sendHostCommand(tabId, 'tab.title.set', { title: newTitle });
      if (tabId === activeTabIdRef.current) {
        setCustomSessionTitle(newTitle);
      }
      // The tab owns its session id; the view's `currentSessionId` is only a
      // projection and may still point at the tab the user just left.
      const target = tabsRef.current.find((t) => t.id === tabId);
      if (target?.sessionId) {
        updateHistoryTitle(target.sessionId, newTitle);
      }
    },
    [setTabs, setCustomSessionTitle, updateHistoryTitle]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabAutoOpenFileEnabled = activeTab?.autoOpenFileEnabled ?? (defaultAutoOpenFileEnabled ?? false);
  const statusPanelExpanded = activeTab?.statusPanelExpanded ?? true;
  const statusPanelTab = activeTab?.statusPanelTab ?? null;

  const setStatusPanelTab = useCallback((tab: TabType | null) => {
    setTabs((prev) => prev.map((item) => (
      item.id === activeTabIdRef.current
        ? { ...item, statusPanelTab: tab }
        : item
    )));
  }, [setTabs]);

  const toggleStatusPanel = useCallback(() => {
    setTabs((prev) => prev.map((item) => (
      item.id === activeTabIdRef.current
        ? { ...item, statusPanelExpanded: !(item.statusPanelExpanded ?? true) }
        : item
    )));
  }, [setTabs]);

  const setActiveTabAutoOpenFileEnabled = useCallback((enabled: boolean) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabIdRef.current) {
          return { ...tab, autoOpenFileEnabled: enabled };
        }
        return tab;
      })
    );
    sendHostCommand(activeTabIdRef.current, 'context.refresh', { enabled });
  }, [setTabs]);

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
  }, [setTabs]);

  return {
    tabs,
    activeTabId,
    tabsRef,
    activeTabIdRef,
    setTabs,
    setActiveTabId,
    closeTabRef,
    renameTab,
    reorderTabs,
    activeTabAutoOpenFileEnabled,
    setActiveTabAutoOpenFileEnabled,
    statusPanelExpanded,
    statusPanelTab,
    setStatusPanelTab,
    toggleStatusPanel,
  };
}
