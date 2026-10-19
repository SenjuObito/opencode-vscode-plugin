/**
 * onSessionHydrated.test.ts
 *
 * 宿主权威快照水化：视图是宿主状态的投影。
 *
 * 前台：整份替换消息列表，并同步 streaming/loading/revert 状态 —— 合并会让上一次
 * 渲染残留的消息留在列表里。
 * 后台：不能动前台列表，但必须更新自己的 tab 快照，否则切回去看到的是旧内容。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerMessageCallbacks } from '../registerCallbacks/messageCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

vi.mock('../../../utils/bridge', () => ({
  cardDebugLog: vi.fn(),
  sendBridgeEvent: vi.fn(),
  sendTypedBridgeEvent: vi.fn(),
}));

interface FakeTab {
  id: string;
  sessionId: string | null;
  messages?: unknown[];
  messageBaseIndex?: number;
  streamingActive?: boolean;
  loading?: boolean;
  status?: string;
  revertBoundaryId?: string | null;
}

function createTabsStore(tabs: FakeTab[], activeTabId: string) {
  return {
    getActiveSessionId: () => tabs.find((t) => t.id === activeTabId)?.sessionId ?? null,
    isActiveSession: (sessionId: string | null | undefined): boolean => {
      if (!sessionId) return false;
      return tabs.find((t) => t.id === activeTabId)?.sessionId === sessionId;
    },
    updateBackgroundTab: (predicate: (tab: FakeTab) => boolean, updater: (tab: FakeTab) => void): boolean => {
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

function createOptions(overrides: Record<string, unknown> = {}): UseWindowCallbacksOptions {
  const ref = <T,>(current: T) => ({ current });
  return {
    addToast: noop,
    setMessages: noop,
    setStatus: noop,
    setLoading: noop,
    setLoadingStartTime: noop,
    setIsThinking: noop,
    setHistoryData: noop,
    userPausedRef: ref(false),
    isUserAtBottomRef: ref(false),
    messagesContainerRef: ref(null),
    suppressNextStatusToastRef: ref(false),
    streamingContentRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    findLastAssistantIndex: (messages: Array<{ type: string }>) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.type === 'assistant') return i;
      }
      return -1;
    },
    extractRawBlocks: () => [],
    patchAssistantForStreaming: (m: unknown) => m,
    updateContextUsageData: noop,
    closeContextUsageDialog: noop,
    currentSessionIdRef: ref('ses_A'),
    ...overrides,
  } as unknown as UseWindowCallbacksOptions;
}

function mount(options: UseWindowCallbacksOptions) {
  registerMessageCallbacks(options, noop, noop);
}

const message = (id: string, text: string) => ({ type: 'assistant', content: text, raw: { id } });

describe('onSessionHydrated', () => {
  let tabs: FakeTab[];

  beforeEach(() => {
    tabs = [
      { id: 'tab-a', sessionId: 'ses_A' },
      { id: 'tab-b', sessionId: 'ses_B' },
    ];
    (window as any).__sessionTabsStore = createTabsStore(tabs, 'tab-a');
  });

  afterEach(() => {
    delete (window as any).__sessionTabsStore;
    delete (window as any).onSessionHydrated;
    delete (window as any).onRevertStateUpdate;
  });

  it('replaces the transcript for the foreground session', () => {
    const setMessages = vi.fn();
    const setStreamingActive = vi.fn();
    mount(createOptions({ setMessages, setStreamingActive }));

    window.onSessionHydrated!(JSON.stringify({
      sessionId: 'ses_A',
      messages: [message('m1', 'hello')],
      isStreaming: true,
      loading: true,
      revertBoundaryId: 'm1',
    }));

    expect(setMessages).toHaveBeenCalledWith([message('m1', 'hello')]);
    expect(setStreamingActive).toHaveBeenCalledWith(true);
    // 水化是整份替换：窗口基准必须归零，否则后续增量按旧基准切片。
    expect(window.__messageBaseIndex).toBe(0);
    expect(window.__opencodeListStart).toBe(0);
  });

  it('reports the revert boundary through onRevertStateUpdate', () => {
    const onRevertStateUpdate = vi.fn();
    (window as any).onRevertStateUpdate = onRevertStateUpdate;
    mount(createOptions({ setMessages: noop }));

    window.onSessionHydrated!(JSON.stringify({
      sessionId: 'ses_A',
      messages: [],
      isStreaming: false,
      revertBoundaryId: 'msg_9',
    }));

    expect(onRevertStateUpdate).toHaveBeenCalledWith(
      'ses_A',
      JSON.stringify({ hasRevert: true, messageId: 'msg_9' }),
    );
  });

  it('does not touch the foreground list for a background session but updates its snapshot', () => {
    const setMessages = vi.fn();
    mount(createOptions({ setMessages }));

    window.onSessionHydrated!(JSON.stringify({
      sessionId: 'ses_B',
      messages: [message('m2', 'background')],
      isStreaming: true,
      loading: true,
      status: 'Thinking',
    }));

    expect(setMessages).not.toHaveBeenCalled();
    expect(tabs[1].messages).toEqual([message('m2', 'background')]);
    expect(tabs[1].streamingActive).toBe(true);
    expect(tabs[1].loading).toBe(true);
    expect(tabs[1].status).toBe('Thinking');
  });

  it('ignores malformed packets instead of wiping the transcript', () => {
    const setMessages = vi.fn();
    mount(createOptions({ setMessages }));

    window.onSessionHydrated!('not json');
    window.onSessionHydrated!(JSON.stringify({ sessionId: 'ses_A', messages: 'nope' }));

    expect(setMessages).not.toHaveBeenCalled();
  });
});
