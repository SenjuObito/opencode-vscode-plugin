/**
 * historyCallbacks.ts
 *
 * Registers the transcript-paging events of one tab:
 *
 *   `history.window`    — how much of the session this tab has read back
 *   `message.prepended` — one older page was prepended on the host
 *
 * <p>Both are addressed to a tab, so they write that tab's record and store.
 * A background tab keeps its own window and transcript; the active view
 * re-renders through the tab store's subscription.</p>
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerHostEvents } from '../../../utils/hostEventRegistry';
import { getTabStore } from '../../../store/tabStore';
import { parseHistoryWindow } from '../../../store/historyWindow';
import { applyPrependToTab, parseEventJson } from '../../../utils/tabEventRouting';
import type { ClaudeMessage } from '../../../types';
import type { HostEventEnvelope } from '../../../utils/hostEventTypes';

function resolveTabId(payload: unknown, env?: HostEventEnvelope): string {
  if (env && typeof env.tabId === 'string' && env.tabId) {
    return env.tabId;
  }
  const fromPayload = (payload as { tabId?: unknown } | undefined)?.tabId;
  return typeof fromPayload === 'string' ? fromPayload : '';
}

export function registerHistoryCallbacks(_options: UseWindowCallbacksOptions): void {
  registerHostEvents({
    'history.window': (payload: unknown, env?: HostEventEnvelope) => {
      const tabId = resolveTabId(payload, env);
      if (!tabId) {
        return;
      }
      const window = parseHistoryWindow(parseEventJson<Record<string, unknown>>(payload));
      if (!window) {
        return;
      }
      const store = getTabStore();
      if (!store.findById(tabId)) {
        // The view has not learned this tab yet; `tab.resync` brings it in and
        // the next load publishes a fresh window.
        return;
      }
      store.updateTab(tabId, (tab) => {
        tab.historyWindow = window;
      });
    },

    'message.prepended': (payload: unknown, env?: HostEventEnvelope) => {
      const tabId = resolveTabId(payload, env);
      if (!tabId) {
        return;
      }
      const parsed = parseEventJson<{ messages?: unknown }>(payload);
      const messages = Array.isArray(parsed?.messages)
        ? (parsed!.messages as ClaudeMessage[])
        : null;
      if (!messages || messages.length === 0) {
        return;
      }
      const store = getTabStore();
      if (!store.findById(tabId)) {
        return;
      }
      store.updateTab(tabId, (tab) => {
        applyPrependToTab(tab, messages);
      });
    },
  });
}
