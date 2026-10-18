/**
 * sessionCallbacks.ts
 *
 * Registers window bridge callbacks for session management,
 * setSessionId, addToast, onExportSessionData.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { downloadJSON } from '../../../utils/exportMarkdown';
import { releaseSessionTransition } from '../sessionTransition';
import { sendBridgeEvent, cardDebugLog } from '../../../utils/bridge';

// Matches session-titles-service.cjs#updateTitle, which rejects longer titles.
const CUSTOM_TITLE_MAX_LENGTH = 50;

export function registerSessionCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<UseWindowCallbacksOptions['t']>,
): void {
  const {
    addToast,
    setCurrentSessionId,
    customSessionTitleRef,
    currentSessionIdRef,
    updateHistoryTitle,
    applyHistoryTitleLocal,
    setCustomSessionTitle,
  } = options;

  window.setSessionId = (sessionId: string, tabId?: string) => {
    const oldId = currentSessionIdRef.current;
    cardDebugLog('[setSessionId] called, sessionId:', sessionId, 'tabId:', tabId, 'oldId:', oldId, 'transitioning:', window.__sessionTransitioning);
    releaseSessionTransition();

    const tabsStore = window.__sessionTabsStore;
    const tabs = tabsStore?.getTabs?.() || [];
    const activeTabId = tabsStore?.getActiveTabId?.();

    let targetTab = tabId ? tabs.find((t) => t.id === tabId || t.sessionId === tabId) : null;
    if (!targetTab) {
      const active = tabs.find((t) => t.id === activeTabId);
      if (active && (!active.sessionId || active.sessionId === sessionId)) {
        targetTab = active;
      } else {
        targetTab = tabs.find((t) => !t.sessionId);
      }
    }

    const syncTitle = () => {
      const title = customSessionTitleRef.current;
      if (title && oldId !== sessionId) {
        if (title.length <= CUSTOM_TITLE_MAX_LENGTH) {
          updateHistoryTitle(sessionId, title);
        } else {
          applyHistoryTitleLocal(sessionId, title);
        }
      }
    };

    if (targetTab) {
      const resolvedTabId = targetTab.id;
      tabsStore?.updateTabSessionId?.(resolvedTabId, sessionId);

      if (resolvedTabId === activeTabId) {
        currentSessionIdRef.current = sessionId;
        setCurrentSessionId(sessionId);
        syncTitle();
      }
    } else {
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      syncTitle();
    }
  };

  window.addToast = (message, type) => {
    addToast(message, type as 'info' | 'success' | 'warning' | 'error' | undefined);
  };

  window.onExportSessionData = (json) => {
    try {
      const data = JSON.parse(json);
      if (data.sessionId && data.messages) {
        const exportContent = JSON.stringify(data, null, 2);
        const sanitizedTitle = (data.title || 'session')
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .substring(0, 50);
        const filename = `${sanitizedTitle}_${data.sessionId.substring(0, 8)}.json`;
        downloadJSON(exportContent, filename);
      } else if (data.error) {
        addToast(data.error, 'error');
      } else {
        addToast(tRef.current('history.exportFailed'), 'error');
      }
    } catch (error) {
      console.error('[Frontend] Failed to process export data:', error);
      addToast(tRef.current('history.exportFailed'), 'error');
    }
  };

  // =========================================================================
  // AI Title Callback
  // =========================================================================

  window.updateSessionTitle = (sessionId: string, title: string) => {
    if (!title || !title.trim() || !sessionId) return;
    const cleanTitle = title.trim();
    if (currentSessionIdRef.current === sessionId || !currentSessionIdRef.current) {
      setCustomSessionTitle(cleanTitle);
    }
    window.__sessionTabsStore?.updateTabTitle?.(sessionId, cleanTitle);
    applyHistoryTitleLocal(sessionId, cleanTitle);
  };

  // =========================================================================
  // SDK-to-CLI Session Conversion Result Callback
  // =========================================================================

  window.onConversionResult = (json: string) => {
    const reloadHistory = () => {
      const provider = options.currentProviderRef.current;
      if (provider) {
        sendBridgeEvent('deep_search_history', provider);
      } else {
        cardDebugLog('[Frontend] Provider unavailable for conversion state reload');
      }
    };

    try {
      const result = JSON.parse(json);
      if (result.success) {
        if (result.infoCode === 'ALREADY_CLI_SESSION') {
          addToast(tRef.current('history.conversionErrors.ALREADY_CLI_SESSION'), 'info');
        } else {
          addToast(tRef.current('history.convertSuccess'), 'success');
          reloadHistory();
        }
        return;
      }

      const errorCode = result.errorCode;
      let errorMessage = tRef.current('history.convertFailed');

      if (errorCode && tRef.current(`history.conversionErrors.${errorCode}`)) {
        errorMessage = tRef.current(`history.conversionErrors.${errorCode}`);
      }

      addToast(errorMessage, 'error');
      reloadHistory();
    } catch (error) {
      console.error('[Frontend] Failed to parse conversion result:', error);
      addToast(tRef.current('history.convertFailed'), 'error');
      reloadHistory();
    }
  };
}
