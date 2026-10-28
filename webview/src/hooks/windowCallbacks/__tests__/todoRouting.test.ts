// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWindowCallbacks } from '../registerCallbacks';
import { getTabStore, resetTabStore } from '../../../store/tabStore';
import type { SessionTabData } from '../../../components/ChatHeader/types';

/**
 * §10.9：todo 事件按 tab 路由。
 *
 * 旧实现只看 `sessionID !== currentSessionId` 就丢弃 —— 后台 tab 的待办列表
 * 因此永远是空的（切回去也看不到）。现在按 sessionID 反查归属 tab：
 * 查得到就写进那个 tab 的记录，查不到才丢弃。
 */
const makeTab = (id: string, sessionId: string): SessionTabData => ({
  id,
  sessionId,
  title: '',
  messages: [],
  sseTodos: null,
} as SessionTabData);

describe('todo 事件按 tab 路由', () => {
  beforeEach(() => {
    resetTabStore();
    const store = getTabStore();
    store.setTabs([makeTab('tab-a', 'ses_a'), makeTab('tab-b', 'ses_b')]);
    store.setActiveTabId('tab-a');
  });

  const register = () => {
    const setSseTodos = vi.fn();
    registerWindowCallbacks({
      setSseTodos,
      currentSessionIdRef: { current: 'ses_a' },
      addToast: vi.fn(),
    } as never);
    return { setSseTodos };
  };

  it('后台 tab 的 todo 写进那个 tab，不进当前 tab', () => {
    const { setSseTodos } = register();

    window.onTodoUpdated?.(JSON.stringify({
      sessionID: 'ses_b',
      todos: [{ id: '1', content: '后台任务', status: 'in_progress' }],
    }));

    const store = getTabStore();
    expect(setSseTodos).not.toHaveBeenCalled();
    expect(store.findById('tab-b')?.sseTodos).toEqual([
      { id: '1', content: '后台任务', status: 'in_progress' },
    ]);
    expect(store.findById('tab-a')?.sseTodos ?? null).toBeNull();
  });

  it('当前 tab 的 todo 照旧进 setSseTodos', () => {
    const { setSseTodos } = register();

    window.onTodoUpdated?.(JSON.stringify({
      sessionID: 'ses_a',
      todos: [{ content: '当前任务', status: 'pending' }],
    }));

    expect(setSseTodos).toHaveBeenCalledTimes(1);
    expect(setSseTodos.mock.calls[0][0]).toEqual([
      { id: '0', content: '当前任务', status: 'pending' },
    ]);
  });

  it('认不出归属 tab 的 todo 丢弃（不能写到当前 tab 上）', () => {
    const { setSseTodos } = register();

    window.onTodoUpdated?.(JSON.stringify({
      sessionID: 'ses_unknown',
      todos: [{ content: '来路不明', status: 'pending' }],
    }));

    expect(setSseTodos).not.toHaveBeenCalled();
    expect(getTabStore().findById('tab-a')?.sseTodos ?? null).toBeNull();
  });

  it('字段名不统一时也能归一（step / done 等）', () => {
    register();

    window.onTodoUpdated?.(JSON.stringify({
      sessionID: 'ses_b',
      todos: [{ step: '第一步', status: 'done' }],
    }));

    expect(getTabStore().findById('tab-b')?.sseTodos).toEqual([
      { id: '0', content: '第一步', status: 'completed' },
    ]);
  });
});
