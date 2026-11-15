import { TabTranscript } from '../../../store/tabTranscript';
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWindowCallbacks } from '../registerCallbacks';
import { getTabStore, resetTabStore } from '../../../store/tabStore';
import { hostEventHandler, resetHostEvents } from '../../../utils/hostEventRegistry';
import type { SessionTabData } from '../../../components/ChatHeader/types';

/**
 * `todos.updated` routes by tab id only.
 *
 * <p>The host owns the session↔tab binding and stamps the owning tab on every
 * tab-scoped event, so this layer never reverse-looks-up a session. These
 * cases pin that contract: the event's tab decides where the list lands, an
 * event that names a tab this view does not know is dropped instead of being
 * written onto whatever is on screen, and an empty list is a real state.</p>
 */
const makeTab = (id: string, sessionId: string): SessionTabData => ({
  id,
  sessionId,
  title: '',
  transcript: new TabTranscript(),
  sseTodos: null,
} as SessionTabData);

const emitTodos = (payload: unknown, tabId?: string) => {
  const handler = hostEventHandler('todos.updated');
  expect(handler).not.toBeNull();
  handler?.(
    { todos: payload },
    tabId ? { type: 'todos.updated', tabId, sessionId: null } : { type: 'todos.updated' },
  );
};

describe('todos.updated 按 tabId 路由', () => {
  beforeEach(() => {
    resetTabStore();
    resetHostEvents();
    const store = getTabStore();
    store.setTabs([makeTab('tab-a', 'ses_a'), makeTab('tab-b', 'ses_b')]);
    store.setActiveTabId('tab-a');
    registerWindowCallbacks(
      {
        setSseTodos: vi.fn(),
        currentSessionIdRef: { current: 'ses_a' },
        addToast: vi.fn(),
      } as never,
      { current: ((key: string) => key) as never },
      () => {},
    );
  });

  it('后台 tab 的事件写进那个 tab，不进当前 tab', () => {
    emitTodos([{ id: '1', content: '后台任务', status: 'in_progress' }], 'tab-b');

    const store = getTabStore();
    expect(store.findById('tab-b')?.sseTodos).toEqual([
      { id: '1', content: '后台任务', status: 'in_progress' },
    ]);
    expect(store.findById('tab-a')?.sseTodos ?? null).toBeNull();
  });

  it('活跃 tab 的事件写进当前 tab', () => {
    emitTodos([{ content: '当前任务', status: 'pending' }], 'tab-a');

    expect(getTabStore().findById('tab-a')?.sseTodos).toEqual([
      { id: '0', content: '当前任务', status: 'pending' },
    ]);
  });

  it('事件的 tab 归属优先于会话：会话属于另一个 tab 也照 tabId 写', () => {
    // The host re-addresses by session, so a payload naming ses_b while the
    // envelope names tab-a is exactly the stale-publisher case: the envelope
    // wins and no view-side session lookup may override it.
    emitTodos({ sessionID: 'ses_b', revision: 7, todos: [{ content: '重定向', status: 'pending' }] }, 'tab-a');

    const store = getTabStore();
    expect(store.findById('tab-a')?.sseTodos).toEqual([
      { id: '0', content: '重定向', status: 'pending' },
    ]);
    expect(store.findById('tab-b')?.sseTodos ?? null).toBeNull();
  });

  it('认不出的 tabId 直接丢弃，不落到当前 tab', () => {
    emitTodos([{ content: '来路不明', status: 'pending' }], 'tab-x');

    expect(getTabStore().findById('tab-a')?.sseTodos ?? null).toBeNull();
  });

  it('没有 tabId 的 legacy 事件只更新当前 tab', () => {
    emitTodos([{ content: '无归属', status: 'pending' }]);

    expect(getTabStore().findById('tab-a')?.sseTodos).toEqual([
      { id: '0', content: '无归属', status: 'pending' },
    ]);
  });

  it('空列表是服务端的真实状态，要清空而不是忽略', () => {
    const store = getTabStore();
    store.updateTab('tab-a', (tab) => ({ ...tab, sseTodos: [{ content: '旧', status: 'pending' }] }));

    emitTodos([], 'tab-a');

    expect(store.findById('tab-a')?.sseTodos).toEqual([]);
  });

  it('core 的裸数组与包装对象两种形态都能解析', () => {
    emitTodos([{ step: '第一步', status: 'done' }], 'tab-b');
    expect(getTabStore().findById('tab-b')?.sseTodos).toEqual([
      { id: '0', content: '第一步', status: 'completed' },
    ]);

    emitTodos({ sessionID: 'ses_b', revision: 2, todos: [{ step: '第二步', status: 'running' }] }, 'tab-b');
    expect(getTabStore().findById('tab-b')?.sseTodos).toEqual([
      { id: '0', content: '第二步', status: 'in_progress' },
    ]);
  });

  it('cancelled 是独立状态，不改写成 completed', () => {
    emitTodos([{ content: '取消掉', status: 'cancelled' }], 'tab-a');

    expect(getTabStore().findById('tab-a')?.sseTodos).toEqual([
      { id: '0', content: '取消掉', status: 'cancelled' },
    ]);
  });
});
