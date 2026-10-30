// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from './useSessionTabs';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeMessage } from '../types';
import { getTabStore, resetTabStore } from '../store/tabStore';
import { dispatchHostEnvelope } from '../utils/hostDispatcher';

const bridgeMocks = vi.hoisted(() => ({
  sendBridgeEvent: vi.fn(),
  sendTabCommand: vi.fn(),
}));

/** Re-emit a command on the envelope the real helper builds. */
const emitCommand = (
  transport: { type: string; tabId?: string | null; sessionId?: string | null; payload?: Record<string, unknown> },
) => bridgeMocks.sendBridgeEvent(
  'host_command',
  JSON.stringify({
    v: 2,
    type: transport.type,
    requestId: `test-${transport.tabId ?? 'none'}-${transport.type}`,
    tabId: transport.tabId ?? null,
    sessionId: transport.sessionId ?? null,
    payload: transport.payload ?? {},
  }),
);

vi.mock('../utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/bridge')>();
  return {
    ...actual,
    sendBridgeEvent: bridgeMocks.sendBridgeEvent,
    // The real `sendTabCommand` calls the module-local `sendBridgeEvent`, which a
    // mock cannot intercept, so the tab commands are re-emitted on the same
    // envelope the real one builds.
    sendTabCommand: (tabId: string, command: string, payload: Record<string, unknown> = {}) => {
      bridgeMocks.sendTabCommand(tabId, command, payload);
      return emitCommand({ type: command, tabId, payload });
    },
    // The real helpers call the module-local `sendBridgeEvent`, which a mock
    // cannot intercept, so they are re-emitted on the same envelope shape.
    sendHostCommand: (
      tabId: string | null | undefined,
      type: string,
      payload: Record<string, unknown> = {},
      sessionId: string | null | undefined = null,
    ) => emitCommand({ type, tabId, sessionId, payload }),
  };
});

/**
 * 多标签页 / 多会话归属测试。
 *
 * 守住的规则只有一条：**一个 id 要么属于某个已知 tab，要么不属于任何地方**。
 * 旧实现在「当前 tab 还没绑定 sessionId」时会认领任意 id，于是后台会话的
 * 快照、终态、弹窗全部写进前台 tab —— 单会话时永远正确，多会话时正好在最要紧
 * 的时刻出错。
 *
 * 注意：`isActiveSession` / `updateBackgroundTab` / `updateTabSessionId` 不通过
 * hook 返回值暴露，而是由 `getTabStore()` 持有给 bridge 回调用，
 * 所以这里按生产同样的入口访问。
 */
describe('useSessionTabs - multi-session attribution', () => {
  const mockT = ((key: string, opts?: any) => opts?.defaultValue || key) as any;
  const dummyFn = vi.fn();
  const emptyMessages: ClaudeMessage[] = [];

  const renderTabs = (overrides: Record<string, unknown> = {}) =>
    renderHook(() =>
      useSessionTabs({
        currentSessionId: null,
        sessionTitle: '',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: emptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
        ...overrides,
      } as any),
    );

  const store = () => getTabStore();

  beforeEach(() => {
    // Every test starts with an empty tab strip.
    resetTabStore();
    vi.clearAllMocks();
    delete window.__dialogStore;
  });

  afterEach(() => {
    delete window.__dialogStore;
  });

  it('treats an empty id as belonging to no session', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });

    expect(store().isActiveSession(null)).toBe(false);
    expect(store().isActiveSession(undefined)).toBe(false);
    expect(store().isActiveSession('')).toBe(false);
    expect(result.current.tabs[0].sessionId).toBe('ses_a');
  });

  it('does not let an unbound tab claim an arbitrary session id', () => {
    // tab-1 还没绑定 sessionId：ses_other 的写入不许被当成前台。
    const { result } = renderTabs({ currentSessionId: null });

    expect(result.current.tabs[0].sessionId).toBeNull();
    expect(store().isActiveSession('ses_other')).toBe(false);
  });

  it('recognizes the active tab session by both session id and tab id', () => {
    renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });

    expect(store().isActiveSession('ses_a')).toBe(true);
    expect(store().isActiveSession('tab-1')).toBe(true);
    expect(store().isActiveSession('ses_b')).toBe(false);
  });

  it('updateBackgroundTab writes only the matching tab and reports the hit', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });
    // tab-1 (ses_a) 变成后台，tab-2 是活跃的空白 tab
    expect(result.current.tabs).toHaveLength(2);

    let stored: boolean | undefined;
    act(() => {
      stored = store().updateBackgroundTab(
        'ses_a',
        (t) => {
          t.pendingPermissions = [{ channelId: 'per_a1' } as any];
        },
      );
    });

    expect(stored).toBe(true);
    expect(result.current.tabs[0].pendingPermissions).toHaveLength(1);
    // 前台 tab 不许被捎带写进去
    expect(result.current.tabs[1].pendingPermissions).toHaveLength(0);
  });

  it('updateBackgroundTab returns false and rebuilds nothing when no tab matches', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });

    const before = result.current.tabs;
    let stored: boolean | undefined;
    act(() => {
      stored = store().updateBackgroundTab(
        'ses_unknown',
        (t) => {
          t.pendingPermissions = [{ channelId: 'nope' } as any];
        },
      );
    });

    expect(stored).toBe(false);
    // 未命中不得触发重渲染：数组引用不变
    expect(result.current.tabs).toBe(before);
    expect(result.current.tabs[0].pendingPermissions ?? []).toHaveLength(0);
  });

  it('matches a background tab by its tab id as well as its session id', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });

    let stored: boolean | undefined;
    act(() => {
      stored = store().updateBackgroundTab(
        'tab-1',
        (t) => {
          t.loading = true;
        },
      );
    });

    expect(stored).toBe(true);
    expect(result.current.tabs[0].loading).toBe(true);
  });

  it('closes a session tab by session id without touching the others', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });
    const newTabId = result.current.tabs[result.current.tabs.length - 1].id;

    act(() => {
      store().closeTabBySessionId('ses_a');
    });

    // 关掉的是 ses_a 那个 tab，另一个 tab 原样留下
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs.map((t) => t.id)).toEqual([newTabId]);
  });

  it('saves and restores the reader position per tab', () => {
    const savedState = { scrollTop: 420, isUserAtBottom: false, userPaused: true };
    const captureScrollState = vi.fn(() => savedState);
    const restoreScrollState = vi.fn();
    const { result } = renderTabs({
      currentSessionId: 'ses_a',
      captureScrollState,
      restoreScrollState,
    });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });

    // Creating a sibling tab snapshots the outgoing tab's position.
    act(() => {
      result.current.createTab();
    });
    expect(result.current.tabs[0].scrollState).toEqual(savedState);

    // Switching back restores that tab's state instead of inheriting the
    // sibling's flags (which would snap the reader to the bottom).
    act(() => {
      result.current.selectTab('tab-1');
    });
    expect(restoreScrollState).toHaveBeenCalledWith(savedState);
  });

  it('keeps a background tab status and prompt written while it was hidden', () => {
    const restore = vi.fn();
    (window as any).__dialogStore = {
      getSnapshot: () => ({ permissions: [], questions: [] }),
      restore,
    };

    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;
    act(() => {
      result.current.createTab();
    });

    // While tab 1 is hidden, a background turn updates its own fields and a
    // permission arrives for it.
    const tab1 = result.current.tabs.find((tab) => tab.id === tab1Id)!;
    act(() => {
      tab1.loading = true;
      tab1.status = 'running';
      tab1.pendingPermissions = [{ channelId: 'per-bg' }];
    });

    act(() => {
      result.current.selectTab(tab1Id);
    });

    const active = result.current.tabs.find((tab) => tab.id === tab1Id)!;
    expect(active.loading).toBe(true);
    expect(active.status).toBe('running');
    expect(restore).toHaveBeenCalledWith([{ channelId: 'per-bg' }], [], []);
  });

  it('follows a host tab.activated broadcast without echoing tab.activate', () => {
    const { result } = renderTabs({ currentSessionId: 'ses_a' });
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;
    act(() => {
      result.current.createTab();
    });
    expect(result.current.activeTabId).not.toBe(tab1Id);

    bridgeMocks.sendTabCommand.mockClear();
    act(() => {
      dispatchHostEnvelope({
        v: 2,
        type: 'tab.activated',
        tabId: tab1Id,
        epoch: 0,
        payload: { tabId: tab1Id },
      });
    });

    expect(result.current.activeTabId).toBe(tab1Id);
    // Host-driven activation must not echo `tab.activate` back (loop).
    expect(bridgeMocks.sendTabCommand).not.toHaveBeenCalledWith(tab1Id, 'tab.activate', {});
  });

  it('applies a remote draft and ignores its own echo', () => {
    const setValue = vi.fn();
    const { result } = renderTabs({
      currentSessionId: 'ses_a',
      chatInputRef: {
        current: {
          setValue,
          setAttachments: vi.fn(),
          restoreFileTags: vi.fn(),
          restoreQuoteTags: vi.fn(),
        },
      },
    });
    const tabId = result.current.activeTabId;

    act(() => {
      dispatchHostEnvelope({
        v: 2,
        type: 'tab.draft.changed',
        tabId,
        epoch: 0,
        payload: { tabId, draft: 'from another view', sourceViewId: 'other-view' },
      });
    });
    expect(setValue).toHaveBeenCalledWith('from another view');

    // The sender's own echo must not rewrite the input (caret jump).
    window.__VIEW_ID__ = 'view-a';
    setValue.mockClear();
    act(() => {
      dispatchHostEnvelope({
        v: 2,
        type: 'tab.draft.changed',
        tabId,
        epoch: 0,
        payload: { tabId, draft: 'echo', sourceViewId: 'view-a' },
      });
    });
    expect(setValue).not.toHaveBeenCalled();
    delete window.__VIEW_ID__;
  });
});


describe('useSessionTabs - history session loading', () => {
  const mockT = ((key: string, opts?: any) => opts?.defaultValue || key) as any;
  const dummyFn = vi.fn();
  const emptyMessages: ClaudeMessage[] = [];

  /**
   * 用可变的 currentSessionId 渲染，模拟父组件状态：
   * openSessionInTab 会调 setCurrentSessionId，父组件必须真的把新 id 传回来，
   * 否则同步 effect 会把 tab.sessionId 重置回 null（这正是生产中父组件的职责）。
   */
  const renderTabsHost = () => {
    const loadHistorySession = vi.fn();
    const setMessages = vi.fn();
    let rerender!: (props: { currentSessionId: string | null }) => void;

    const view = renderHook(
      ({ currentSessionId }: { currentSessionId: string | null }) =>
        useSessionTabs({
          currentSessionId,
          setCurrentSessionId: (id: string | null) => rerender({ currentSessionId: id }),
          sessionTitle: '',
          setCustomSessionTitle: dummyFn,
          updateHistoryTitle: dummyFn,
          messages: emptyMessages,
          setMessages,
          loading: false,
          streamingActive: false,
          isShared: false,
          forceCreateNewSession: dummyFn,
          loadHistorySession,
          t: mockT,
        } as any),
      { initialProps: { currentSessionId: null as string | null } },
    );
    rerender = view.rerender;

    return { ...view, loadHistorySession, setMessages };
  };

  const store = () => getTabStore();

  beforeEach(() => {
    // Every test starts with an empty tab strip.
    resetTabStore();
    vi.clearAllMocks();
    delete window.__dialogStore;
  });

  afterEach(() => {
    delete window.__dialogStore;
  });

  it('binds a freshly opened history session to the blank draft tab', () => {
    const { result, loadHistorySession, unmount } = renderTabsHost();

    act(() => {
      result.current.openSessionInTab('ses_h1', '历史会话 1');
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].sessionId).toBe('ses_h1');
    expect(result.current.tabs[0].title).toBe('历史会话 1');
    expect(loadHistorySession).toHaveBeenCalledWith('ses_h1', result.current.tabs[0].id);
    unmount();
  });

  it('opens a second history session in its own tab', () => {
    const { result, loadHistorySession, unmount } = renderTabsHost();

    act(() => {
      result.current.openSessionInTab('ses_h1', '历史会话 1');
    });
    act(() => {
      result.current.openSessionInTab('ses_h2', '历史会话 2');
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].sessionId).toBe('ses_h1');
    expect(result.current.tabs[1].sessionId).toBe('ses_h2');
    expect(result.current.activeTabId).toBe(result.current.tabs[1].id);
    expect(loadHistorySession).toHaveBeenNthCalledWith(1, 'ses_h1', result.current.tabs[0].id);
    expect(loadHistorySession).toHaveBeenNthCalledWith(2, 'ses_h2', result.current.tabs[1].id);
    unmount();
  });

  it('jumps to the existing tab instead of duplicating an already-open session', () => {
    const { result, loadHistorySession, unmount } = renderTabsHost();

    act(() => {
      result.current.openSessionInTab('ses_h1', '历史会话 1');
    });
    act(() => {
      result.current.openSessionInTab('ses_h2', '历史会话 2');
    });
    const firstTabId = result.current.tabs[0].id;

    act(() => {
      result.current.openSessionInTab('ses_h1', '历史会话 1');
    });

    // 不新建 tab，只是切回去
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe(firstTabId);
    // 已经打开的会话不需要重新加载
    expect(loadHistorySession).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('keeps each history session transcript on its own tab', () => {
    const { result, unmount } = renderTabsHost();

    act(() => {
      result.current.openSessionInTab('ses_h1', '历史会话 1');
    });
    act(() => {
      result.current.openSessionInTab('ses_h2', '历史会话 2');
    });
    const h1TabId = result.current.tabs[0].id;

    // 两个后台/前台快照各自写各自的 tab
    act(() => {
      store().updateBackgroundTab(
        'ses_h1',
        (t) => {
          t.messages = [{ type: 'user', content: 'H1 question' }] as ClaudeMessage[];
        },
      );
    });
    act(() => {
      store().updateBackgroundTab(
        'ses_h2',
        (t) => {
          t.messages = [{ type: 'user', content: 'H2 question' }] as ClaudeMessage[];
        },
      );
    });

    const h1 = result.current.tabs.find((t) => t.sessionId === 'ses_h1');
    const h2 = result.current.tabs.find((t) => t.sessionId === 'ses_h2');
    expect(h1?.messages).toEqual([{ type: 'user', content: 'H1 question' }]);
    expect(h2?.messages).toEqual([{ type: 'user', content: 'H2 question' }]);

    // 切回 h1：恢复的必须是 h1 自己的 transcript，而不是 h2 的
    act(() => {
      result.current.selectTab(h1TabId);
    });
    expect(result.current.activeTabId).toBe(h1TabId);
    expect(result.current.tabs.find((t) => t.id === h1TabId)?.messages)
      .toEqual([{ type: 'user', content: 'H1 question' }]);
    unmount();
  });

  it('allows at most one unbound new tab and focuses it on subsequent createTab calls', () => {
    const { result, unmount } = renderTabsHost();
    // Default initial tab has no sessionId
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].sessionId).toBeNull();
    const firstTabId = result.current.tabs[0].id;

    // Creating another tab when an unbound tab already exists should NOT create a second unbound tab
    act(() => {
      result.current.createTab();
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(firstTabId);
    unmount();
  });


  it('preserves and restores sliding window cursors per tab', () => {
    const { result, unmount } = renderTabsHost();
    // Tab 1: bind to ses_1 and set cursor
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_1');
      window.__messageBaseIndex = 15;
      window.__opencodeListStart = 10;
      window.__prependedHistoryMessageCount = 5;
    });

    // Open session 2
    act(() => {
      result.current.openSessionInTab('ses_2', 'Session 2');
    });

    // In Session 2, set different cursors
    act(() => {
      window.__messageBaseIndex = 42;
      window.__opencodeListStart = 30;
      window.__prependedHistoryMessageCount = 12;
    });

    const tab1Id = result.current.tabs[0].id;
    // Switch back to Tab 1
    act(() => {
      result.current.selectTab(tab1Id);
    });

    // Window cursors should be restored from Tab 1's snapshot!
    expect(window.__messageBaseIndex).toBe(15);
    expect(window.__opencodeListStart).toBe(10);
    expect(window.__prependedHistoryMessageCount).toBe(5);

    unmount();
  });

  it('keeps each tab its own attachments and file tags across a switch', () => {
    // Attachments and file tags live inside the input box (uncontrolled mode).
    // The tab switcher can only preserve them by reading them out before the
    // switch and writing them back after — this pins that round-trip.
    const attachmentsA = [
      { id: 'a1', fileName: 'a.png', mediaType: 'image/png', data: 'AAA' },
    ];
    const fileTagsA = [{ displayPath: '@src/a.ts', absolutePath: '/repo/src/a.ts' }];

    let draft = { text: 'draft A', attachments: attachmentsA, fileTags: fileTagsA };
    const chatInputRef = {
      current: {
        getValue: () => draft.text,
        setValue: (value: string) => {
          draft = { ...draft, text: value };
        },
        getAttachments: () => draft.attachments,
        setAttachments: (next: typeof attachmentsA) => {
          draft = { ...draft, attachments: next };
        },
        getFileTags: () => draft.fileTags,
        restoreFileTags: (next: typeof fileTagsA) => {
          draft = { ...draft, fileTags: next };
        },
        focus: () => {},
        clear: () => {},
        hasContent: () => true,
      },
    };

    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'ses_a',
        sessionTitle: '',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: emptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        chatInputRef,
        t: mockT,
      } as any),
    );

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;

    // Open a second tab: tab-1's draft is archived on the way out.
    act(() => {
      result.current.createTab();
    });
    expect(result.current.activeTabId).not.toBe(tab1Id);

    // The new tab starts clean — no attachment leaked from tab-1.
    act(() => {
      draft = { text: '', attachments: [], fileTags: [] };
      result.current.selectTab(tab1Id);
    });

    expect(draft.attachments).toEqual(attachmentsA);
    expect(draft.fileTags).toEqual(fileTagsA);
    expect(draft.text).toBe('draft A');
  });

  it('activates the host tab before replaying build/plan mode', () => {
    // `set_mode` is scoped to this tab's session, but the host's active tab
    // still feeds window-level notifications. Activating the target tab first
    // keeps those observers from seeing the outgoing tab.
    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'ses_a',
        sessionTitle: '',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: emptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
      } as any),
    );

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;

    act(() => {
      result.current.createTab();
    });

    vi.mocked(sendBridgeEvent).mockClear();
    act(() => {
      result.current.selectTab(tab1Id);
    });

    // Every command travels on one transport; the envelope names its type.
    const calls = vi.mocked(sendBridgeEvent).mock.calls
      .filter((c) => c[0] === 'host_command')
      .map((c) => JSON.parse(String(c[1])));
    const activateCall = calls.findIndex((c) => c.type === 'tab.activate');
    const modeCall = calls.findIndex((c) => c.type === 'settings.mode');

    expect(activateCall).toBeGreaterThanOrEqual(0);
    expect(modeCall).toBeGreaterThanOrEqual(0);
    expect(activateCall).toBeLessThan(modeCall);

    // Activation is by stable tab id; the mode payload is scoped to the session.
    expect(calls[activateCall].tabId).toBe(tab1Id);
    expect(calls[modeCall].sessionId).toBe('ses_a');
  });

  it('does not rewrite the host session when creating an unbound tab', () => {
    // A new tab has no session id, so `set_model` / `set_mode` /
    // `set_reasoning_effort` have no target. The first send_message carries the
    // values instead; sending them here used to rewrite the outgoing session.
    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'ses_a',
        sessionTitle: '',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: emptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        setSelectedModel: dummyFn,
        setReasoningEffort: dummyFn,
        t: mockT,
      } as any),
    );

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });

    vi.mocked(sendBridgeEvent).mockClear();
    act(() => {
      result.current.createTab();
    });

    const configCalls = vi.mocked(sendBridgeEvent).mock.calls.filter(
      (c) => c[0] === 'set_model' || c[0] === 'set_mode' || c[0] === 'set_reasoning_effort',
    );
    expect(configCalls).toEqual([]);
  });

  it('moves the host session when closing the active tab', () => {
    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'ses_a',
        sessionTitle: '',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: emptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
      } as any),
    );

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;

    // tab-2 becomes active with its own session.
    act(() => {
      result.current.createTab();
    });
    const tab2Id = result.current.activeTabId;
    act(() => {
      store().updateTabSessionId(tab2Id, 'ses_b');
    });

    vi.mocked(sendBridgeEvent).mockClear();
    act(() => {
      result.current.closeTab(tab2Id);
    });

    // Without this the host's active tab would remain the tab just closed.
    const activateCall = vi.mocked(sendBridgeEvent).mock.calls
      .filter((c) => c[0] === 'host_command')
      .map((c) => JSON.parse(String(c[1])))
      .find((envelope) => envelope.type === 'tab.activate');
    expect(activateCall?.tabId).toBe(tab1Id);
    expect(result.current.activeTabId).toBe(tab1Id);
  });

  it('never routes a title to an unbound tab when no session matches', () => {
    const setCustomTitle = vi.fn();
    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: null,
        sessionTitle: '',
        setCustomSessionTitle: setCustomTitle,
        updateHistoryTitle: vi.fn(),
        messages: emptyMessages,
        setMessages: vi.fn(),
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: vi.fn(),
        loadHistorySession: vi.fn(),
        t: ((k: string, opts?: any) => opts?.defaultValue || k) as any,
      } as any),
    );

    // Initial draft tab has sessionId === null
    expect(result.current.tabs[0].sessionId).toBeNull();
    expect(result.current.tabs[0].title).toBe('新会话');

    // A title for a session this tab is not bound to must be ignored.
    act(() => {
      getTabStore().updateTabTitle('ses_new_123', 'AI生成的标题');
    });

    expect(result.current.tabs[0].title).toBe('新会话');
    expect(setCustomTitle).not.toHaveBeenCalled();

    // Once the tab is bound, titles for that session apply normally.
    act(() => {
      getTabStore().updateTabSessionId('tab-1', 'ses_new_123');
    });
    act(() => {
      getTabStore().updateTabTitle('ses_new_123', '更新后的标题');
    });
    expect(result.current.tabs[0].title).toBe('更新后的标题');
  });

  it('does not leak a background session title into a newly created unbound tab', () => {
    const setCustomTitle = vi.fn();
    const { result } = renderHook(() => {
      const [sessionId, setSessionId] = useState<string | null>(null);
      return useSessionTabs({
        currentSessionId: sessionId,
        setCurrentSessionId: setSessionId,
        sessionTitle: '',
        setCustomSessionTitle: setCustomTitle,
        updateHistoryTitle: vi.fn(),
        messages: emptyMessages,
        setMessages: vi.fn(),
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: vi.fn(),
        loadHistorySession: vi.fn(),
        t: mockT,
      } as any);
    });

    // Bind the first tab to session A, then create a second (unbound) draft tab.
    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });
    setCustomTitle.mockClear();

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].sessionId).toBe('ses_a');
    expect(result.current.tabs[1].sessionId).toBeNull();

    // The AI finishes titling session A while session B's draft is on screen.
    act(() => {
      store().updateTabTitle('ses_a', '会话 A 的标题');
    });

    // Only session A's tab changes; the draft tab must keep its placeholder.
    expect(result.current.tabs[0].title).toBe('会话 A 的标题');
    expect(result.current.tabs[1].title).toBe('新会话');
    expect(setCustomTitle).not.toHaveBeenCalled();
  });

  it('lets a new tab inherit the active tab selection instead of hard-coded defaults', () => {
    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: null,
        sessionTitle: '',
        setCustomSessionTitle: vi.fn(),
        updateHistoryTitle: vi.fn(),
        messages: emptyMessages,
        setMessages: vi.fn(),
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: vi.fn(),
        loadHistorySession: vi.fn(),
        selectedModel: 'opencode/deepseek-v4',
        permissionMode: 'plan',
        reasoningEffort: 'high',
        t: mockT,
      } as any),
    );

    expect(result.current.tabs[0]).toMatchObject({
      selectedModel: 'opencode/deepseek-v4',
      permissionMode: 'plan',
      reasoningEffort: 'high',
    });

    act(() => {
      result.current.createTab();
    });

    const fresh = result.current.tabs[result.current.tabs.length - 1];
    expect(fresh).toMatchObject({
      selectedModel: 'opencode/deepseek-v4',
      permissionMode: 'plan',
      reasoningEffort: 'high',
    });
    expect(fresh.sessionId).toBeNull();
  });

  it('keeps the StatusPanel expanded/page selection on each tab', () => {
    const { result } = renderHook(() => {
      const [sessionId, setSessionId] = useState<string | null>(null);
      return useSessionTabs({
        currentSessionId: sessionId,
        setCurrentSessionId: setSessionId,
        sessionTitle: '',
        setCustomSessionTitle: vi.fn(),
        updateHistoryTitle: vi.fn(),
        messages: emptyMessages,
        setMessages: vi.fn(),
        loading: false,
        streamingActive: false,
        isShared: false,
        forceCreateNewSession: vi.fn(),
        loadHistorySession: vi.fn(),
        t: mockT,
      } as any);
    });

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    const tab1Id = result.current.activeTabId;
    act(() => {
      result.current.createTab();
    });
    const tab2Id = result.current.activeTabId;

    // Tab 2 opens Edits and collapses its panel.
    act(() => {
      result.current.setStatusPanelTab('files');
      result.current.toggleStatusPanel();
    });
    expect(result.current.statusPanelTab).toBe('files');
    expect(result.current.statusPanelExpanded).toBe(false);

    // Tab 1 keeps its own default view state.
    act(() => {
      result.current.selectTab(tab1Id);
    });
    expect(result.current.statusPanelTab).toBeNull();
    expect(result.current.statusPanelExpanded).toBe(true);

    // Returning to tab 2 restores exactly what it had.
    act(() => {
      result.current.selectTab(tab2Id);
    });
    expect(result.current.statusPanelTab).toBe('files');
    expect(result.current.statusPanelExpanded).toBe(false);
  });
});


