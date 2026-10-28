/**
 * useSessionTabs.ts
 *
 * Top-level coordinator for session tabs.
 * Refactored and modularized into focused domain hooks under ./sessionTabs/:
 * - useTabBarState: Tab list, active tracking, title and metadata syncing, window store
 * - useTabSessionBinder: Snapshot capture, view switching, history loading, resync
 * - useTabLifecycle: Creation, closing, forking, window action exposure
 */

import { useState } from 'react';
import { TabDraftStore } from '../store/tabDraftStore';
import { TabStatusStore } from '../store/tabStatusStore';
import { TabPromptStore } from '../store/tabPromptStore';
import type { UseSessionTabsOptions } from './sessionTabs/types';
import { useTabBarState } from './sessionTabs/useTabBarState';
import { useTabSessionBinder } from './sessionTabs/useTabSessionBinder';
import { useTabLifecycle } from './sessionTabs/useTabLifecycle';

export type { UseSessionTabsOptions } from './sessionTabs/types';

export function useSessionTabs(options: UseSessionTabsOptions) {
  const [draftStore] = useState(() => new TabDraftStore());
  const [statusStore] = useState(() => new TabStatusStore());
  const [promptStore] = useState(() => new TabPromptStore());

  const tabBar = useTabBarState({
    ...options,
    draftStore,
  });

  const binder = useTabSessionBinder({
    ...options,
    tabBar,
    draftStore,
    statusStore,
    promptStore,
  });

  const lifecycle = useTabLifecycle({
    ...options,
    tabBar,
    draftStore,
    statusStore,
    promptStore,
    saveCurrentTabSnapshot: binder.saveCurrentTabSnapshot,
    selectTab: binder.selectTab,
    syncHostActiveTabTo: binder.syncHostActiveTabTo,
    syncPermissionModeTo: binder.syncPermissionModeTo,
  });

  return {
    tabs: tabBar.tabs,
    activeTabId: tabBar.activeTabId,
    selectTab: binder.selectTab,
    createTab: lifecycle.createTab,
    closeTab: lifecycle.closeTab,
    closeOtherTabs: lifecycle.closeOtherTabs,
    closeTabsToLeft: lifecycle.closeTabsToLeft,
    closeTabsToRight: lifecycle.closeTabsToRight,
    closeAllTabs: lifecycle.closeAllTabs,
    renameTab: tabBar.renameTab,
    forkTab: lifecycle.forkTab,
    reorderTabs: tabBar.reorderTabs,
    openSessionInTab: binder.openSessionInTab,
    activeTabAutoOpenFileEnabled: tabBar.activeTabAutoOpenFileEnabled,
    setActiveTabAutoOpenFileEnabled: tabBar.setActiveTabAutoOpenFileEnabled,
    statusPanelExpanded: tabBar.statusPanelExpanded,
    statusPanelTab: tabBar.statusPanelTab,
    setStatusPanelTab: tabBar.setStatusPanelTab,
    toggleStatusPanel: tabBar.toggleStatusPanel,
  };
}
