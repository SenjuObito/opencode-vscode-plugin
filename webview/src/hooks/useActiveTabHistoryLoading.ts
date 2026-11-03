/**
 * Whether the tab on screen is waiting for its history.
 *
 * <p>The state belongs to the tab, so the subscription reads the active tab
 * instead of a window-wide flag: switching tabs shows that tab's own
 * indicator, and a load finishing elsewhere changes nothing on screen.</p>
 */
import { useSyncExternalStore } from 'react';
import { getTabStore } from '../store/tabStore';

export function useActiveTabHistoryLoading(): boolean {
  const store = getTabStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.isActiveTabHistoryLoading(),
    () => false,
  );
}
