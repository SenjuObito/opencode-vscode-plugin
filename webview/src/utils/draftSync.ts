/**
 * Cross-view draft sync (`tab.draft.changed`).
 *
 * <p>Two views can show the same active tab. Typing in one should be visible in
 * the other after a short idle, without echoing back to the sender (which would
 * reset the caret). The active tab id is read from the tab store, so the input
 * component needs no tab prop.</p>
 */
import { getTabStore } from '../store/tabStore';
import { sendHostCommand } from './bridge';
import { getViewId } from './viewIdentity';

const DEBOUNCE_MS = 300;

let timer: number | null = null;

/** Publish the active tab's draft after the user stops typing. */
export function notifyActiveTabDraft(text: string): void {
  const tabId = getTabStore().getActiveTabId();
  if (!tabId) {
    return;
  }
  if (timer !== null) {
    window.clearTimeout(timer);
  }
  timer = window.setTimeout(() => {
    timer = null;
    sendHostCommand(tabId, 'tab.draft.changed', {
      draft: text,
      sourceViewId: getViewId(),
    });
  }, DEBOUNCE_MS);
}

/** Test hook: cancel a pending publish. */
export function resetDraftSync(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}
