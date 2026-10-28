import { describe, expect, it, vi } from 'vitest';
import { TabStore, createTabId } from './tabStore';
import type { SessionTabData } from '../components/ChatHeader/types';

const tab = (id: string, sessionId: string | null = null): SessionTabData => ({
  id,
  sessionId,
  title: id,
  messages: [],
});

describe('TabStore', () => {
  it('creates unique stable tab ids instead of timestamp-only ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createTabId()));
    expect(ids.size).toBe(100);
  });

  it('notifies subscribers only when tabs or the active id actually change', () => {
    const store = new TabStore([tab('tab-1')], 'tab-1');
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTabId('tab-1');
    expect(listener).not.toHaveBeenCalled();

    store.setActiveTabId('tab-2');
    expect(listener).toHaveBeenCalledTimes(1);

    const current = store.getTabs();
    store.setTabs(current);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setTabs((prev) => [...prev, tab('tab-2')]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('emits once after a tabs updater also switches the active id', () => {
    const store = new TabStore([tab('tab-1')], 'tab-1');
    const snapshots: Array<[string, string[]]> = [];
    store.subscribe(() => {
      snapshots.push([store.getActiveTabId(), store.getTabs().map((item) => item.id)]);
    });

    store.setTabs((prev) => {
      store.setActiveTabId('tab-2');
      return [...prev, tab('tab-2')];
    });

    expect(snapshots).toEqual([['tab-2', ['tab-1', 'tab-2']]]);
  });

  it('writes runtime state to the active tab, not to the window', () => {
    const store = new TabStore([tab('tab-1'), tab('tab-2')], 'tab-1');

    store.updateActiveTab((active) => ({ ...active, loading: true, streamingActive: true }));

    expect(store.findById('tab-1')?.loading).toBe(true);
    expect(store.findById('tab-1')?.streamingActive).toBe(true);
    expect(store.findById('tab-2')?.loading).toBeUndefined();
    expect(store.getActiveTab().id).toBe('tab-1');

    store.setActiveTabId('tab-2');
    expect(store.getActiveTab().loading).toBeUndefined();
  });

  it('keeps a detached runtime before the first tab exists', () => {
    const store = new TabStore([], '');
    const listener = vi.fn();
    store.subscribe(listener);

    store.updateActiveTab((active) => ({ ...active, loading: true }));

    expect(store.getActiveTab().loading).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resolves tabs by both stable tab id and session id', () => {
    const store = new TabStore([tab('tab-1', 'ses_a'), tab('tab-2')], 'tab-1');

    expect(store.findById('tab-2')?.id).toBe('tab-2');
    expect(store.findIdBySession('ses_a')).toBe('tab-1');
    expect(store.findIdBySession('tab-2')).toBe('tab-2');
    expect(store.findIdBySession('ses_missing')).toBeNull();
  });

  it('stops notifying after unsubscribe', () => {
    const store = new TabStore([tab('tab-1')], 'tab-1');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.setActiveTabId('tab-2');

    expect(listener).not.toHaveBeenCalled();
  });

  it('decides "active session" from the tab binding, never from a view projection', () => {
    // The regression this guards: routing asked the view's current session,
    // which lags a commit behind, so the tab that really held the session was
    // treated as background while the previous session's events were treated
    // as foreground.
    const store = new TabStore([tab('tab-1', 'ses_a'), tab('tab-2', 'ses_b')], 'tab-1');

    expect(store.isActiveSession('ses_a')).toBe(true);
    expect(store.isActiveSession('ses_b')).toBe(false);
    expect(store.getActiveSessionId()).toBe('ses_a');

    store.setActiveTabId('tab-2');
    expect(store.isActiveSession('ses_a')).toBe(false);
    expect(store.isActiveSession('ses_b')).toBe(true);
    expect(store.getActiveSessionId()).toBe('ses_b');
  });

  it('keeps a title that arrived before the session was bound', () => {
    const store = new TabStore([tab('tab-1', null)], 'tab-1');

    store.updateTabTitle('ses_late', 'AI title');
    expect(store.findById('tab-1')?.title).toBe('tab-1');

    store.updateTabSessionId('tab-1', 'ses_late');
    expect(store.findById('tab-1')?.title).toBe('AI title');
    expect(store.findById('tab-1')?.sessionId).toBe('ses_late');
  });

  it('never lets a generated title replace a title the user set', () => {
    const store = new TabStore([
      { ...tab('tab-1', 'ses_a'), title: '我的会话', isCustomTitle: true },
    ], 'tab-1');

    store.updateTabTitle('ses_a', 'AI title', 'tab-1');

    expect(store.findById('tab-1')?.title).toBe('我的会话');
  });
});
