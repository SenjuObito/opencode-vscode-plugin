/**
 * messageMergeCache.ts
 *
 * Per-tab message merge cache partition.
 * Ensures each tab has an isolated merge cache that:
 * 1. Persists across tab switches so returning to an existing tab doesn't re-merge
 * 2. Is deterministically released when a tab is closed (preventing leaks)
 * 3. Enforces a per-tab upper bound to prevent unbounded heap growth
 */

export const MESSAGE_MERGE_CACHE_LIMIT = 3000;

export interface MergeCacheEntry<M = unknown> {
  source: M[];
  merged: M;
}

const tabCaches = new Map<string, Map<string, MergeCacheEntry<any>>>();

/**
 * Get or create the message merge cache for a specific tab.
 */
export function getTabMergeCache<M = any>(tabId: string): Map<string, MergeCacheEntry<M>> {
  if (!tabId) {
    tabId = '__detached';
  }
  let cache = tabCaches.get(tabId);
  if (!cache) {
    cache = new Map();
    tabCaches.set(tabId, cache);
  }
  return cache;
}

/**
 * Clear the merge cache for a specific tab when it is closed.
 */
export function clearTabMergeCache(tabId: string): void {
  if (!tabId) return;
  const cache = tabCaches.get(tabId);
  if (cache) {
    cache.clear();
    tabCaches.delete(tabId);
  }
}

/**
 * Drop all tab caches (used in tests or webview resets).
 */
export function clearAllTabMergeCaches(): void {
  tabCaches.forEach((cache) => cache.clear());
  tabCaches.clear();
}
