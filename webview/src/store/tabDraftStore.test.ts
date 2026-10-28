import { describe, expect, it } from 'vitest';
import { TabDraftStore } from './tabDraftStore';

describe('TabDraftStore', () => {
  it('keeps drafts isolated per tab and returns all for quote preservation', () => {
    const store = new TabDraftStore();
    store.set('tab-a', { text: 'A', attachments: [], fileTags: [] });
    store.set('tab-b', { text: 'B', attachments: [], fileTags: [] });

    expect(store.get('tab-a')?.text).toBe('A');
    expect(store.get('tab-b')?.text).toBe('B');
    expect(store.getAll().map((draft) => draft.text)).toEqual(['A', 'B']);
  });

  it('drops the draft when its tab closes', () => {
    const store = new TabDraftStore();
    store.set('tab-a', { text: 'A', attachments: [], fileTags: [] });

    store.delete('tab-a');

    expect(store.get('tab-a')).toBeUndefined();
    expect(store.getAll()).toEqual([]);
  });
});
