/**
 * Layout math for the session tab bar.
 *
 * <p>The bar renders a width-based prefix of the session tabs and collapses the
 * rest into the overflow ("…") menu. Two invariants must hold at all times:</p>
 *
 * <ol>
 *   <li>{@code visibleTabs} and {@code overflowTabs} are a partition of the tab
 *       list: every tab is in exactly one of them. Rebuilding one list from the
 *       other (as the old in-component swap did) is what let a tab disappear
 *       from both during a re-render.</li>
 *   <li>A <em>forced</em> tab — the active session, or the tab the user just
 *       dragged out of the overflow menu — stays visible even when the
 *       width-based prefix would not reach it. This is the fix for "a long
 *       titled tab dragged out of the ⋯ menu snaps back into it": the drop put
 *       it in a visible slot, then the post-reorder width recalculation shrank
 *       the prefix below its index. Trailing non-forced tabs are evicted
 *       instead.</li>
 * </ol>
 */

/** Gap between two rendered session tabs (`.session-tabs-container`). */
export const SESSION_TAB_GAP = 4;

/** Space kept free for the overflow button: 32px button + one gap. */
export const SESSION_TAB_OVERFLOW_RESERVE = 36;

/** Width assumed for a tab that has never been rendered in the bar. */
export const SESSION_TAB_FALLBACK_WIDTH = 110;

/** `.session-tab-item { max-width: 150px }` — the widest a bar tab can be. */
export const SESSION_TAB_MAX_WIDTH = 150;

/**
 * Number of leading tabs that fit in `availableWidth`.
 *
 * <p>Mirrors the original in-component loop: stop at the first tab that does
 * not fit, and always keep at least one tab so the bar is never empty.</p>
 */
export function calculateVisibleCount(
  widths: readonly number[],
  availableWidth: number,
  gap: number = SESSION_TAB_GAP,
): number {
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const extra = count > 0 ? gap : 0;
    if (used + extra + width <= availableWidth) {
      used += extra + width;
      count += 1;
    } else {
      break;
    }
  }
  return Math.max(1, count);
}

export interface TabPartition<T> {
  visibleTabs: T[];
  overflowTabs: T[];
}

/**
 * Split the tab list into the rendered prefix and the overflow menu.
 *
 * @param tabs            Tabs in their user-visible order.
 * @param visibleCount    Capacity from {@link calculateVisibleCount}.
 * @param forcedIds       Tabs that must never be collapsed (active + just dropped).
 * @param widthOf         Width of one tab; measured or the fallback estimate.
 * @param availableWidth  Width budget for the tabs themselves; pass
 *                        {@link Number.POSITIVE_INFINITY} when everything fits.
 */
export function partitionTabs<T extends { id: string }>(
  tabs: readonly T[],
  visibleCount: number,
  forcedIds: ReadonlySet<string>,
  widthOf: (id: string) => number,
  availableWidth: number,
  gap: number = SESSION_TAB_GAP,
): TabPartition<T> {
  const visibleIds = new Set<string>();
  const limit = Math.max(0, Math.min(visibleCount, tabs.length));
  for (let i = 0; i < limit; i += 1) {
    visibleIds.add(tabs[i].id);
  }

  // Forced tabs are added even when they sit past the width-based prefix.
  for (const tab of tabs) {
    if (forcedIds.has(tab.id)) visibleIds.add(tab.id);
  }

  const visibleWidth = (): number => {
    let used = 0;
    let count = 0;
    for (const tab of tabs) {
      if (!visibleIds.has(tab.id)) continue;
      used += (count > 0 ? gap : 0) + widthOf(tab.id);
      count += 1;
    }
    return used;
  };

  // Forcing a wider tab in can exceed the budget; evict trailing tabs that are
  // not forced so the bar keeps fitting instead of pushing the overflow button
  // off-screen. A single forced tab is kept even if it alone is too wide.
  while (visibleIds.size > 1 && visibleWidth() > availableWidth) {
    let evicted = false;
    for (let i = tabs.length - 1; i >= 0; i -= 1) {
      const { id } = tabs[i];
      if (!visibleIds.has(id) || forcedIds.has(id)) continue;
      visibleIds.delete(id);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }

  return {
    visibleTabs: tabs.filter((tab) => visibleIds.has(tab.id)),
    overflowTabs: tabs.filter((tab) => !visibleIds.has(tab.id)),
  };
}
