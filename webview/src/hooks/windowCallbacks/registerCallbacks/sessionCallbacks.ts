/**
 * sessionCallbacks.ts
 *
 * Registers window bridge callbacks for session management,
 * setSessionId, addToast, onExportSessionData.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { downloadJSON } from '../../../utils/exportMarkdown';
import { activeTabId, endTransition, isTabTransitioning, transitionTargetFor } from '../tabTransition';
import { getTabStore } from '../../../store/tabStore';
import type { HostEventEnvelope, HostEventPayload } from '../../../utils/hostEventTypes';
import { cardDebugLog } from '../../../utils/bridge';
import { registerHostEvents } from '../../../utils/hostEventRegistry';
import { isEnginePlaceholderTitle } from '../../../utils/sessionTitle';

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
    setLoading,
    setStreamingActive,
  } = options;

  const setSessionId = (payload: HostEventPayload | undefined, env?: HostEventEnvelope) => {
    const rawSessionId = typeof payload === 'string' ? payload : (payload?.sessionId ?? '');
    const sessionId = String(rawSessionId ?? '');
    if (!sessionId) return;
    const previousSessionId = typeof payload === 'object' ? (payload?.previousSessionId as string | undefined) : undefined;
    const tabId = env?.tabId ?? (typeof payload === 'object' ? (payload?.tabId as string | undefined) : undefined);
    const oldId = currentSessionIdRef.current;
    cardDebugLog(
      '[setSessionId] called, sessionId:',
      sessionId,
      'previousSessionId:',
      previousSessionId,
      'tabId:',
      tabId,
      'oldId:',
      oldId,
      'transitioning:',
      isTabTransitioning(getTabStore().getActiveTabId()),
    );

    const tabStore = getTabStore();
    const tabs = tabStore.getTabs();
    const currentActiveTabId = tabStore.getActiveTabId();
    const activeTab = tabs.find((t) => t.id === currentActiveTabId);

    let targetTab = tabId ? tabs.find((t) => t.id === tabId) : null;
    if (!targetTab && !tabId) {
      targetTab = previousSessionId
        ? tabs.find((t) => t.id === previousSessionId || t.sessionId === previousSessionId)
        : null;
      if (!targetTab) {
        targetTab = tabs.find((t) => t.sessionId === sessionId);
      }
      if (!targetTab && (previousSessionId === '' || previousSessionId === undefined) && activeTab && !activeTab.sessionId) {
        targetTab = activeTab;
      }
    }

    if (targetTab) {
      tabStore.updateTabSessionId(targetTab.id, sessionId);
    }

    if (targetTab && currentActiveTabId && targetTab.id !== currentActiveTabId) {
      return;
    }

    currentSessionIdRef.current = sessionId;
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

    const ownerTabId = (targetTab ? targetTab.id : (tabStore.findIdBySession(sessionId) ?? null)) ?? activeTabId();
    if (!transitionTargetFor(ownerTabId)) {
      endTransition(ownerTabId);
    }
  };

  const handleAddToast = (message: string, type?: string) => {
    addToast(message, type as 'info' | 'success' | 'warning' | 'error' | undefined);
  };

  /**
   * A command was refused by the host. The rejection is routed back to the
   * tab that sent the command, so a refused send is visible instead of silently swallowed.
   */
  const commandRejected = (payload: HostEventPayload | undefined, env?: HostEventEnvelope) => {
    const tabId = String(payload?.tabId ?? env?.tabId ?? '');
    const requestId = String(payload?.requestId ?? '');
    const code = String(payload?.code ?? '');
    const message = String(payload?.message ?? '');
    cardDebugLog('[commandRejected] code:', code, 'tab:', tabId, 'request:', requestId, 'message:', message);
    const text = message || code;
    if (text) {
      addToast(text, 'error');
    }
    setLoading?.(false);
    setStreamingActive?.(false);
  };

  /**
   * An attachment upload failed.
   */
  const onAttachmentFailed = (payload: HostEventPayload | undefined) => {
    const fileName = String(payload?.fileName ?? '');
    const code = String(payload?.code ?? '');
    const message = String(payload?.message ?? '');
    cardDebugLog('[attachmentFailed] code:', code, 'file:', fileName, 'message:', message);
    const text = message || code;
    if (text) {
      addToast(text, 'error');
    }
  };

  const updateSessionTitle = (
    payloadOrSessionId: HostEventPayload | string | undefined,
    envOrTitle?: HostEventEnvelope | string,
  ) => {
    let title = '';
    let sessionId = '';
    let tabId: string | undefined;

    if (typeof payloadOrSessionId === 'string' && typeof envOrTitle === 'string') {
      sessionId = payloadOrSessionId;
      title = envOrTitle;
    } else if (typeof payloadOrSessionId === 'object' && payloadOrSessionId !== null) {
      title = String(payloadOrSessionId.title ?? '');
      sessionId = (typeof envOrTitle === 'object' ? envOrTitle?.sessionId : undefined) ?? String(payloadOrSessionId.sessionId ?? '');
      tabId = typeof envOrTitle === 'object' ? envOrTitle?.tabId : (payloadOrSessionId.tabId as string | undefined);
    } else if (typeof payloadOrSessionId === 'string') {
      title = payloadOrSessionId;
      sessionId = typeof envOrTitle === 'object' ? (envOrTitle?.sessionId ?? '') : '';
      tabId = typeof envOrTitle === 'object' ? envOrTitle?.tabId : undefined;
    }
    if (!title || !title.trim() || !sessionId) return;
    const cleanTitle = title.trim();
    if (isEnginePlaceholderTitle(cleanTitle)) return;

    if (currentSessionIdRef.current === sessionId) {
      setCustomSessionTitle(cleanTitle);
    }
    getTabStore().updateTabTitle(sessionId, cleanTitle, tabId);
    applyHistoryTitleLocal(sessionId, cleanTitle);
  };

  // Window callbacks (legacy fallback)
  window.setSessionId = (sessionId: string) => {
    setSessionId({ sessionId });
  };

  window.addToast = (message, type) => {
    handleAddToast(message, type);
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

  window.updateSessionTitle = (sessionId: string, title: string) => {
    updateSessionTitle({ title, sessionId });
  };

  // Semantic event registrations
  registerHostEvents({
    'command.rejected': commandRejected,
    'attachment.failed': onAttachmentFailed,
    'session.bound': setSessionId,
    'tab.title.changed': updateSessionTitle,
    'toast.shown': handleAddToast,
  });
}
