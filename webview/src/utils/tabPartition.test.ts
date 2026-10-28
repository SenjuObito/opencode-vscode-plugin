import { describe, expect, it } from 'vitest';
import {
  calculateVisibleCount,
  partitionTabs,
  SESSION_TAB_FALLBACK_WIDTH,
  SESSION_TAB_MAX_WIDTH,
} from './tabPartition';

const makeTabs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `tab-${index + 1}` }));

const constantWidth = (width: number) => () => width;

describe('calculateVisibleCount', () => {
  it('counts the tabs that fit, gap included', () => {
    expect(calculateVisibleCount([110, 110, 110, 110], 224)).toBe(2);
    expect(calculateVisibleCount([110, 110, 110, 110], 225)).toBe(2);
    expect(calculateVisibleCount([110, 110, 110, 110], 452)).toBe(4);
  });

  it('stops at the first tab that does not fit instead of packing later ones', () => {
    // 150 + gap + 150 = 304 > 240, so the trailing 80 is never considered.
    expect(calculateVisibleCount([150, 150, 80], 240)).toBe(1);
  });

  it('never returns zero, so the bar is never empty', () => {
    expect(calculateVisibleCount([110], 10)).toBe(1);
    expect(calculateVisibleCount([], 200)).toBe(1);
  });
});

describe('partitionTabs', () => {
  it('is a partition of the tab list for any input', () => {
    const tabs = makeTabs(6);
    const { visibleTabs, overflowTabs } = partitionTabs(
      tabs, 3, new Set(['tab-5']), constantWidth(120), 300,
    );

    const all = [...visibleTabs, ...overflowTabs].map((tab) => tab.id);
    expect(all).toHaveLength(6);
    expect(new Set(all)).toEqual(new Set(tabs.map((tab) => tab.id)));
    // Order is preserved inside both lists.
    expect(visibleTabs.map((tab) => tab.id)).toEqual(
      tabs.map((tab) => tab.id).filter((id) => visibleTabs.some((tab) => tab.id === id)),
    );
  });

  it('promotes a forced tab that the prefix does not reach and evicts a trailing tab', () => {
    const tabs = makeTabs(5);
    const { visibleTabs, overflowTabs } = partitionTabs(
      tabs, 3, new Set(['tab-5']), constantWidth(100), 310,
    );

    // 3 visible tabs fit (100*3 + 2*4 = 308 <= 310); forcing tab-5 keeps the
    // count at three by evicting tab-3, not by growing the bar.
    expect(visibleTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-5']);
    expect(overflowTabs.map((tab) => tab.id)).toEqual(['tab-3', 'tab-4']);
  });

  it('keeps the dropped long-title tab visible even when the prefix shrinks', () => {
    // The reported bug: the bar fits two 110px tabs, the dropped tab is the
    // 150px one, so the width-based prefix after the reorder no longer reaches
    // its index and it used to fall back into the collapsed menu.
    const tabs = makeTabs(4);
    const widthOf = (id: string) => (id === 'tab-4' ? SESSION_TAB_MAX_WIDTH : SESSION_TAB_FALLBACK_WIDTH);

    const { visibleTabs, overflowTabs } = partitionTabs(tabs, 2, new Set(['tab-4']), widthOf, 270);

    expect(visibleTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-4']);
    expect(overflowTabs.map((tab) => tab.id)).toEqual(['tab-2', 'tab-3']);
    // The kept layout still fits the bar budget.
    expect(SESSION_TAB_FALLBACK_WIDTH + 4 + SESSION_TAB_MAX_WIDTH).toBeLessThanOrEqual(270);
  });

  it('trims as many trailing tabs as needed to fit the budget', () => {
    const tabs = makeTabs(5);
    const { visibleTabs } = partitionTabs(tabs, 3, new Set(['tab-5']), constantWidth(150), 300);

    // {1,2,3,5} = 612 > 300; {1,2,5} = 458 > 300; {1,5} = 304 > 300; {5} = 150.
    expect(visibleTabs.map((tab) => tab.id)).toEqual(['tab-5']);
  });

  it('never trims when everything fits (unbounded budget)', () => {
    const tabs = makeTabs(4);
    const { visibleTabs, overflowTabs } = partitionTabs(
      tabs, tabs.length, new Set(['tab-3']), constantWidth(110), Number.POSITIVE_INFINITY,
    );

    expect(visibleTabs).toHaveLength(4);
    expect(overflowTabs).toHaveLength(0);
  });

  it('ignores forced ids that are not part of the tab list', () => {
    const tabs = makeTabs(3);
    const { visibleTabs, overflowTabs } = partitionTabs(
      tabs, 2, new Set(['tab-gone']), constantWidth(100), 204,
    );

    expect(visibleTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
    expect(overflowTabs.map((tab) => tab.id)).toEqual(['tab-3']);
  });
});
