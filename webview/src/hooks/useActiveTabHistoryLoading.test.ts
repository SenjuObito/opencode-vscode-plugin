/**
 * The "waiting for history" indicator is tab state.
 *
 * <p>Every assertion here exists because the indicator used to be a
 * window-wide flag: a load finishing (or a reset running) in one tab hid the
 * indicator of the tab on screen, and switching tabs lost it entirely.</p>
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useActiveTabHistoryLoading } from './useActiveTabHistoryLoading';
import { getTabStore } from '../store/tabStore';
import { seedTabStore } from '../test/seedTabStore';

describe('useActiveTabHistoryLoading', () => {
  afterEach(() => {
    seedTabStore([{ id: 'tab-a' }], 'tab-a');
  });

  it('reports the load of the tab on screen, not of another tab', () => {
    seedTabStore([
      { id: 'tab-a', sessionId: 'ses-a' },
      { id: 'tab-b', sessionId: 'ses-b' },
    ], 'tab-a');
    const store = getTabStore();

    store.setHistoryLoading('tab-b', true);

    expect(store.isActiveTabHistoryLoading()).toBe(false);

    store.setActiveTabId('tab-b');

    expect(store.isActiveTabHistoryLoading()).toBe(true);
  });

  it('keeps the indicator of a loading tab when the load elsewhere finishes', () => {
    seedTabStore([
      { id: 'tab-a', sessionId: 'ses-a' },
      { id: 'tab-b', sessionId: 'ses-b' },
    ], 'tab-a');
    const store = getTabStore();
    store.setHistoryLoading('tab-a', true);
    store.setHistoryLoading('tab-b', true);

    store.setSessionHistoryLoading('ses-b', false);

    expect(store.findById('tab-a')?.historyLoading).toBe(true);
    expect(store.findById('tab-b')?.historyLoading).toBe(false);
  });

  it('renders the indicator from the active tab and follows a switch', () => {
    seedTabStore([
      { id: 'tab-a', sessionId: 'ses-a' },
      { id: 'tab-b', sessionId: 'ses-b' },
    ], 'tab-b');
    const store = getTabStore();
    store.setHistoryLoading('tab-b', true);

    const { result, rerender } = renderHook(() => useActiveTabHistoryLoading());

    expect(result.current).toBe(true);

    store.setActiveTabId('tab-a');
    rerender();

    expect(result.current).toBe(false);
  });
});
