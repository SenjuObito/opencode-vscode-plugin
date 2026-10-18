/**
 * messageCallbacks.historyRouting.test.ts
 *
 * 历史会话加载 / 多会话快照的归属路由。
 *
 * 宿主对每一次推送都带 sessionId（`updateMessages(sessionId, json, seq)`）。
 * 这里守住的规则：**写操作只落在持有该 sessionId 的 tab 上；没有任何 tab 持有
 * 时，落到当前视图而不是被丢掉**（丢掉的表现是「会话打开了却是空的」）。
 *
 * 另一条是会话切换守卫：`__sessionTransitioning` 期间，只有目标会话的快照被放行，
 * 旧会话残留的帧一律拒绝 —— 否则切会话后旧对话会重新长出来。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerMessageCallbacks } from './messageCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';

type Ref<T> = { current: T };
const ref = <T>(value: T): Ref<T> => ({ current: value });

interface FakeTab {
  id: string;
  sessionId: string | null;
  messages?: ClaudeMessage[];
  loading?: boolean;
  streamingActive?: boolean;
  pendingPermissions?: unknown[];
  pendingQuestions?: unknown[];
}

function createTabsStore(tabs: FakeTab[], activeTabId: string, activeSessionId: string | null) {
  return {
    getActiveSessionId: () => activeSessionId,
    isActiveSession: (sessionId: string | null | undefined): boolean => {
      if (!sessionId) return false;
      const active = tabs.find((t) => t.id === activeTabId);
      if (!active) return false;
      return active.sessionId === sessionId || active.id === sessionId;
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

function createHarness(activeSessionId: string) {
  let messages: ClaudeMessage[] = [];
  const setMessages = vi.fn((updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  });
  const setSessionLoading = vi.fn();
  const requestHistoryRenderCommit = vi.fn();
  const resetTransientUiState = vi.fn();

  const options = {
    addToast: vi.fn(),
    setMessages,
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setHistoryData: vi.fn(),
    setSessionLoading,
    userPausedRef: ref(false),
    isUserAtBottomRef: ref(true),
    messagesContainerRef: ref(null),
    suppressNextStatusToastRef: ref(false),
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    lastContentUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref<number | null>(null),
    lastThinkingUpdateRef: ref(0),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    currentProviderRef: ref('opencode'),
    currentSessionIdRef: ref<string | null>(activeSessionId),
    findLastAssistantIndex: (list: ClaudeMessage[]) =>
      list.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1),
    extractRawBlocks: () => [],
    patchAssistantForStreaming: (m: ClaudeMessage) => ({ ...m, isStreaming: true }),
    updateContextUsageData: vi.fn(),
    closeContextUsageDialog: vi.fn(),
  } as unknown as UseWindowCallbacksOptions;

  registerMessageCallbacks(options, resetTransientUiState, requestHistoryRenderCommit);

  return {
    setMessages,
    setSessionLoading,
    requestHistoryRenderCommit,
    resetTransientUiState,
    getMessages: () => messages,
    options,
  };
}

const historySnapshot = (): ClaudeMessage[] => [
  { type: 'user', content: 'history question', timestamp: '2026-01-01T00:00:00.000Z' },
  { type: 'assistant', content: 'history answer', timestamp: '2026-01-01T00:00:01.000Z' },
];

describe('history load routing — background session', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    delete window.__sessionTabsStore;
    delete window.__sessionTransitionTargetSessionId;
    delete window.__pendingHistoryRefreshMessageCount;
    delete window.__lastAcceptedMessageCount;
    delete window.__minAcceptedUpdateSequence;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    window.__sessionTransitioning = false;
  });

  it('writes a background session snapshot onto ITS tab and leaves the foreground alone', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-fg', sessionId: 'ses_fg', messages: [{ type: 'user', content: 'fg' }] },
      { id: 'tab-bg', sessionId: 'ses_bg', messages: [] },
    ];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;

    window.updateMessages!('ses_bg', JSON.stringify(historySnapshot()), '11');

    expect(h.setMessages).not.toHaveBeenCalled();
    expect(tabs[1].messages).toHaveLength(2);
    expect(tabs[1].messages![0].content).toBe('history question');
    // 前台 tab 的 transcript 一个字符都不许动
    expect(tabs[0].messages).toEqual([{ type: 'user', content: 'fg' }]);
  });

  it('clears only the background tab it names', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-fg', sessionId: 'ses_fg', messages: [{ type: 'user', content: 'fg' }] },
      { id: 'tab-bg', sessionId: 'ses_bg', messages: [{ type: 'user', content: 'bg' }] },
    ];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;

    window.clearMessages!('ses_bg', '21');

    expect(tabs[1].messages).toEqual([]);
    expect(h.setMessages).not.toHaveBeenCalled();
    expect(tabs[0].messages).toEqual([{ type: 'user', content: 'fg' }]);
  });

  it('does not release the foreground transition guard for a background load', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-fg', sessionId: 'ses_fg', messages: [] },
      { id: 'tab-bg', sessionId: 'ses_bg', messages: [], loading: true },
    ];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;
    window.__sessionTransitioning = true;

    window.historyLoadComplete!('ses_bg', '2');

    // 前台还在切换中：守卫必须留着，否则前台会被旧会话的帧污染
    expect(window.__sessionTransitioning).toBe(true);
    expect(tabs[1].loading).toBe(false);
    // 前台的 loading 条不被后台会话的完成信号解除
    expect(h.setSessionLoading).not.toHaveBeenCalledWith(true);
  });

  it('falls through to the active view when NO tab claims the session', () => {
    // 回归：会话还没有对应 tab 时，旧代码把快照丢掉 → 「打开了却是空的」。
    const tabs: FakeTab[] = [{ id: 'tab-fg', sessionId: 'ses_fg', messages: [] }];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;

    window.updateMessages!('ses_unbound', JSON.stringify(historySnapshot()), '31');

    expect(h.setMessages).toHaveBeenCalled();
    expect(h.getMessages()).toHaveLength(2);
    expect(h.getMessages()[1].content).toBe('history answer');
  });
});

describe('history load routing — foreground session', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    delete window.__sessionTabsStore;
    delete window.__sessionTransitionTargetSessionId;
    delete window.__pendingHistoryRefreshMessageCount;
    delete window.__lastAcceptedMessageCount;
    delete window.__minAcceptedUpdateSequence;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    window.__sessionTransitioning = false;
  });

  it('runs the full load sequence: clear → snapshot → complete', () => {
    const h = createHarness('ses_fg');
    window.__sessionTransitioning = true;

    window.clearMessages!('ses_fg', '7');
    expect(h.setMessages).toHaveBeenLastCalledWith([]);

    window.updateMessages!('ses_fg', JSON.stringify(historySnapshot()), '8');
    expect(h.getMessages()).toHaveLength(2);

    window.historyLoadComplete!('ses_fg', '2');

    // 切换守卫被正确释放，且历史表面刷新被请求一次
    expect(window.__sessionTransitioning).toBe(false);
    expect(h.requestHistoryRenderCommit).toHaveBeenCalledTimes(1);
    expect(h.setSessionLoading).toHaveBeenCalledWith(false);
    expect(h.getMessages()).toHaveLength(2);
  });

  it('rejects a stale snapshot from the previous session while transitioning', () => {
    // 旧会话的帧带着更小的 sequence，必须在守卫与序列屏障处被挡掉。
    const h = createHarness('ses_fg');
    window.__sessionTransitioning = true;
    window.clearMessages!('ses_fg', '7');

    window.updateMessages!('ses_fg', JSON.stringify([
      { type: 'user', content: 'STALE from the old session', timestamp: '2025-01-01T00:00:00.000Z' },
    ]), '3');

    expect(h.getMessages()).toEqual([]);
  });

  it('blocks another session snapshot while the foreground is transitioning', () => {
    const tabs: FakeTab[] = [{ id: 'tab-fg', sessionId: 'ses_fg', messages: [] }];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;
    window.__sessionTransitioning = true;

    window.updateMessages!('ses_other', JSON.stringify(historySnapshot()), '9');

    expect(h.setMessages).not.toHaveBeenCalled();
    expect(tabs[0].messages).toEqual([]);
  });
});

describe('patchMessageUuid — 会话归属与签名', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    delete window.__sessionTabsStore;
    delete window.__sessionTransitionTargetSessionId;
    delete window.__lastAcceptedMessageCount;
    delete window.__minAcceptedUpdateSequence;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    window.__sessionTransitioning = false;
  });

  it('follows the host 3-arg convention (sessionId, content, uuid)', () => {
    // 回归：签名曾与宿主错位（宿主发 3 参、这里只收 2 参），content 槽位
    // 收到的是 sessionId，整个补丁静默失效——谁的消息都补不上 uuid。
    const h = createHarness('ses_fg');
    h.setMessages([
      { type: 'user', content: '同一个问题', timestamp: '2026-01-01T00:00:00.000Z' },
    ] as ClaudeMessage[]);

    window.patchMessageUuid!('ses_fg', '同一个问题', 'uuid-777');

    expect(h.getMessages()[0]).toMatchObject({ raw: { uuid: 'uuid-777' } });
  });

  it('writes a background session patch onto THAT tab, not the foreground list', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-fg', sessionId: 'ses_fg', messages: [{ type: 'user', content: 'fg' }] },
      { id: 'tab-bg', sessionId: 'ses_bg', messages: [{ type: 'user', content: '同一个问题' }] },
    ];
    const h = createHarness('ses_fg');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-fg', 'ses_fg') as unknown as typeof window.__sessionTabsStore;

    window.patchMessageUuid!('ses_bg', '同一个问题', 'uuid-888');

    expect(h.setMessages).not.toHaveBeenCalled();
    expect(tabs[1].messages![0]).toMatchObject({ raw: { uuid: 'uuid-888' } });
    expect(tabs[0].messages).toEqual([{ type: 'user', content: 'fg' }]);
  });

  it('is dropped when the patch carries no session identity', () => {
    const h = createHarness('ses_fg');
    h.setMessages([{ type: 'user', content: '同一个问题' }] as ClaudeMessage[]);

    window.patchMessageUuid!(undefined as unknown as string, '同一个问题', 'uuid-999');

    expect(h.getMessages()[0]).not.toHaveProperty('raw.uuid');
  });
});
