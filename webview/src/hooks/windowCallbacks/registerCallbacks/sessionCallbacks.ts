/**
 * sessionCallbacks.ts
 *
 * Registers window bridge callbacks for session management,
 * setSessionId, addToast, onExportSessionData.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { downloadJSON } from '../../../utils/exportMarkdown';
import { endTransition, activeTabId, transitionTargetFor } from '../tabTransition';
import { getTabStore } from '../../../store/tabStore';

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

  window.setSessionId = (sessionId: string) => {
    const oldId = currentSessionIdRef.current;
    // Release a pending transition only when this is NOT a history load: those
    // carry a transition target and must wait for `historyLoadComplete`. The
    // new-session flow has no target and relies on this release so the first
    // deltas are accepted.
    const ownerTabId = getTabStore().findIdBySession(sessionId) ?? activeTabId();
    if (!transitionTargetFor(ownerTabId)) {
      endTransition(ownerTabId);
    }
    currentSessionIdRef.current = sessionId;
    // Keep the tab record in sync too: a view that learned this binding from a
    // replayed snapshot must not keep `sessionId: null` until the next switch
    // (rename/find-by-session read the record).
    const boundTabId = activeTabId();
    if (boundTabId) {
      getTabStore().updateTabSessionId(boundTabId, sessionId);
    }
    setCurrentSessionId(sessionId);

    // B-011 + B-014: Persist custom title under the real SDK session ID.
    const title = customSessionTitleRef.current;
    if (title && oldId !== sessionId) {
      if (title.length <= CUSTOM_TITLE_MAX_LENGTH) {
        updateHistoryTitle(sessionId, title);
      } else {
        applyHistoryTitleLocal(sessionId, title);
      }
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
    if (currentSessionIdRef.current === sessionId) {
      setCustomSessionTitle(title.trim());
    }
    applyHistoryTitleLocal(sessionId, title.trim());
  };

}
