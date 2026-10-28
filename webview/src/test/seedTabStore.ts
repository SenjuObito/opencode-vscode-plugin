/**
 * Tab identity for tests.
 *
 * <p>Command routing reads the authoritative {@code getTabStore()}, not a
 * window-level mirror, so a test that needs a bound tab seeds the store itself.
 * Only the identity fields are needed for routing; the cast keeps the helper
 * usable from suites that do not care about the rest of a tab's view state.</p>
 */
import type { SessionTabData } from '../components/ChatHeader/types';
import { getTabStore, resetTabStore } from '../store/tabStore';

export interface SeedTab {
  id: string;
  sessionId?: string | null;
  /** A title the user typed; auto titles must never be persisted on bind. */
  isCustomTitle?: boolean;
}

/** Replace the store's tabs and active tab. */
export function seedTabStore(tabs: SeedTab[], activeTabId: string): void {
  resetTabStore();
  const store = getTabStore();
  store.setTabs(tabs.map((tab) => ({ sessionId: null, ...tab } as unknown as SessionTabData)));
  store.setActiveTabId(activeTabId);
}

/** Drop the store's state between tests. */
export function clearTabStore(): void {
  resetTabStore();
}
