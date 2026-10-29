import { describe, expect, it } from 'vitest';
import { TabPromptStore } from './tabPromptStore';

describe('per-tab prompt store', () => {
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
