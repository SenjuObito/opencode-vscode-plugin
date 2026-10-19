/**
 * callbackRouting.test.ts
 *
 * 会话路由契约：宿主自多会话改造后一律按 `(sessionId, payload)` 下发，
 * 事件必须落到 payload 所属会话，而不是「当前前台」。
 *
 * 这组用例看守真实故障：
 *  - `JSON.parse(sessionId)` 抛错被 catch 吞掉 → 子代理进度 / SSE todo /
 *    message.removed 三条推送长期静默失效；
 *  - 即使解包成功，后台会话的 task / todo 若写进前台 state，会把 A 会话的
 *    子代理显示到 B 会话里。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerWindowCallbacks } from '../registerCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

vi.mock('../../../utils/bridge', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/bridge')>('../../../utils/bridge');
  return {
    ...actual,
    cardDebugLog: vi.fn(),
    sendBridgeEvent: vi.fn(),
    sendTypedBridgeEvent: vi.fn(),
  };
});

interface FakeTab {
  id: string;
  sessionId: string | null;
  messages?: unknown[];
  taskEvents?: Record<string, unknown>;
  sseTodos?: unknown[];
}

function createTabsStore(tabs: FakeTab[], activeTabId: string) {
  return {
    getActiveTabId: () => activeTabId,
    getActiveSessionId: () => tabs.find((t) => t.id === activeTabId)?.sessionId ?? null,
    getTabs: () => tabs,
    isActiveSession: (sessionId: string | null | undefined): boolean => {
      if (!sessionId) return false;
      const active = tabs.find((t) => t.id === activeTabId);
      if (!active) return false;
      return active.sessionId === sessionId;
    },
    updateBackgroundTab: (
      predicate: (tab: FakeTab) => boolean,
      updater: (tab: FakeTab) => void,
    ): boolean => {
      const idx = tabs.findIndex(predicate);
      if (idx === -1) return false;
      const clone = { ...tabs[idx] };
      updater(clone);
      tabs[idx] = clone;
      return true;
    },
  };
}

const noop = () => {};

function createOptions(overrides: Partial<UseWindowCallbacksOptions> = {}): UseWindowCallbacksOptions {
  const ref = <T,>(current: T) => ({ current });
  return {
    clearToasts: noop,
    setStatus: noop as any,
    setLoading: noop as any,
    setLoadingStartTime: noop as any,
    setIsThinking: noop as any,
    setStreamingActive: noop as any,
    setSessionLoading: noop as any,
    setIsCompacting: noop as any,
    setCompactingStartTime: noop as any,
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    contentUpdateTimeoutRef: ref<number | null>(null),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    streamingTurnIdRef: ref(-1),
    currentSessionIdRef: ref('ses_A'),
    ...overrides,
  } as unknown as UseWindowCallbacksOptions;
}

function mount(options: UseWindowCallbacksOptions) {
  registerWindowCallbacks(options, { current: ((k: string) => k) as any }, noop);
}

describe('host callback session routing', () => {
  let tabs: FakeTab[];

  beforeEach(() => {
    tabs = [
      { id: 'tab-a', sessionId: 'ses_A' },
      { id: 'tab-b', sessionId: 'ses_B' },
    ];
  });

  afterEach(() => {
    delete (window as any).__sessionTabsStore;
    delete (window as any).onTaskEvent;
    delete (window as any).onTodoUpdated;
    delete (window as any).__resetTransientUiState;
  });

  it('routes task events for a background session into that tab, not the active state', () => {
    const setTaskEvents = vi.fn();
    (window as any).__sessionTabsStore = createTabsStore(tabs, 'tab-a');
    mount(createOptions({ setTaskEvents }));

    window.onTaskEvent!(
      'ses_B',
      JSON.stringify({ subtype: 'task_notification', status: 'completed', tool_use_id: 'tool-1', summary: 'done' }),
    );

    expect(setTaskEvents).not.toHaveBeenCalled();
    expect(tabs[1].taskEvents).toMatchObject({ 'tool-1': { status: 'completed' } });
  });

  it('still accepts the legacy single-argument task event payload', () => {
    const setTaskEvents = vi.fn();
    (window as any).__sessionTabsStore = createTabsStore(tabs, 'tab-a');
    mount(createOptions({ setTaskEvents }));

    window.onTaskEvent!(JSON.stringify({ subtype: 'task_notification', status: 'completed', tool_use_id: 'tool-2' }));

    expect(setTaskEvents).toHaveBeenCalledTimes(1);
    const updater = setTaskEvents.mock.calls[0][0] as (prev: Record<string, unknown>) => Record<string, unknown>;
    expect(updater({})).toMatchObject({ 'tool-2': { status: 'completed' } });
  });

  it('writes SSE todos into the background tab that owns the session', () => {
    const setSseTodos = vi.fn();
    (window as any).__sessionTabsStore = createTabsStore(tabs, 'tab-a');
    mount(createOptions({ setSseTodos }));

    window.onTodoUpdated!(
      'ses_B',
      JSON.stringify({ sessionID: 'ses_B', todos: [{ id: '1', content: 'step', status: 'pending' }] }),
    );

    expect(setSseTodos).not.toHaveBeenCalled();
    expect(tabs[1].sseTodos).toEqual([{ id: '1', content: 'step', status: 'pending' }]);
  });

  it('updates the active list when todos belong to the foreground session', () => {
    const setSseTodos = vi.fn();
    (window as any).__sessionTabsStore = createTabsStore(tabs, 'tab-a');
    mount(createOptions({ setSseTodos }));

    window.onTodoUpdated!(
      'ses_A',
      JSON.stringify({ sessionID: 'ses_A', todos: [{ id: '1', content: 'step', status: 'in_progress' }] }),
    );

    expect(setSseTodos).toHaveBeenCalledWith([{ id: '1', content: 'step', status: 'in_progress' }]);
  });
});
