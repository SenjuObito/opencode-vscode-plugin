/**
 * queueCallbacks.ts
 *
 * Registers `tab.queue.changed`: the host's projection of one tab's outbox.
 *
 * <p>The event is addressed to a tab, so it writes that tab's record in the
 * store. A background tab keeps its own queue and badge; the active tab's
 * queue is what the composer renders. No React state is involved, which is why
 * a tab switch cannot move an item between queues.</p>
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerHostEvents } from '../../../utils/hostEventRegistry';
import { getTabStore } from '../../../store/tabStore';
import { parseTabQueuePayload } from '../../../store/tabQueueStore';
import type { HostEventEnvelope } from '../../../utils/hostEventTypes';

export function registerQueueCallbacks(_options: UseWindowCallbacksOptions): void {
  registerHostEvents({
    'tab.queue.changed': (payload: unknown, env?: HostEventEnvelope) => {
      const tabId = typeof env?.tabId === 'string' && env.tabId
        ? env.tabId
        : (typeof (payload as { tabId?: unknown } | undefined)?.tabId === 'string'
          ? String((payload as { tabId: string }).tabId)
          : '');
      if (!tabId) {
        return;
      }
      const snapshot = parseTabQueuePayload(payload);
      if (!snapshot) {
        return;
      }
      const store = getTabStore();
      if (!store.findById(tabId)) {
        // The view has not learned this tab yet; `tab.resync`/`tab.created`
        // brings it in and the resync replay publishes the queue again.
        return;
      }
      store.updateTab(tabId, (tab) => {
        tab.queue = snapshot;
      });
    },
  });
}
