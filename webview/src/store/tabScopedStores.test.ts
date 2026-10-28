import { describe, expect, it } from 'vitest';
import { TabStatusStore } from './tabStatusStore';
import { TabPromptStore } from './tabPromptStore';

describe('per-tab status and prompt stores', () => {
  it('keeps one status snapshot per tab and forgets a closed tab', () => {
    const store = new TabStatusStore();
    const statusA = {
      loading: true,
      streamingActive: true,
      isThinking: false,
      status: 'running',
      revertBoundaryId: null,
      isCompacting: false,
      compactingStartTime: null,
      taskEvents: {},
      sseTodos: null,
      subagentHistories: {},
      filteredFileChanges: [],
      turnStartedAt: 1,
      usagePercentage: 10,
    };

    store.set('tab-a', statusA);
    store.set('tab-b', { ...statusA, loading: false, status: '' });

    expect(store.get('tab-a')).toBe(statusA);
    expect(store.get('tab-b')?.status).toBe('');

    store.delete('tab-a');
    expect(store.get('tab-a')).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it('keeps pending prompts keyed by tab and drops them with the tab', () => {
    const store = new TabPromptStore();
    store.set('tab-a', { permissions: [{ requestId: 'p1' }], questions: [] });
    store.set('tab-b', { permissions: [], questions: [{ requestId: 'q1' }] });

    expect(store.get('tab-a')?.permissions).toHaveLength(1);
    expect(store.get('tab-b')?.questions).toHaveLength(1);

    store.delete('tab-b');
    expect(store.get('tab-b')).toBeUndefined();
    expect(store.size()).toBe(1);
  });
});
