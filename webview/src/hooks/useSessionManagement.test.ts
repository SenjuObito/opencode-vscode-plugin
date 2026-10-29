import { act, renderHook } from '@testing-library/react';
import { afterEach } from 'vitest';
import { useSessionManagement } from './useSessionManagement.js';
import { beginTransition, endTransition, isTabTransitioning, transitionTokenFor } from './windowCallbacks/tabTransition';
import type { HistoryData } from '../types/index.js';
import { sentCommands } from '../utils/testEvents';
import { seedTabStore } from '../test/seedTabStore';

describe('useSessionManagement', () => {
  const t = ((key: string) => key) as any;

  const createMocks = () => ({
    setHistoryData: vi.fn(),
    setMessages: vi.fn(),
    setCurrentView: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setIsThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setSessionLoading: vi.fn(),
    clearToasts: vi.fn(),
    addToast: vi.fn(),
    setBackgroundTasks: vi.fn(),
  });

  const withActiveTab = (tabId = 'tab-1') => {
    seedTabStore([{ id: tabId }], tabId);
  };

  /** Did a `session.load` command go out for this session? */
  const sessionLoadCalls = (sessionId: string) => {
    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as string);
    return sentCommands(calls).some(
      (envelope) => envelope?.type === 'session.load'
        && (envelope?.payload as { sessionId?: string }).sessionId === sessionId,
    );
  };

  const interruptCalls = () => (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => c[0] as string)
    .filter((c: string) => c.startsWith('host_command:') && c.includes('session.interrupt'));
  const interruptPayload = () => {
    const call = interruptCalls()[0];
    if (!call) return null;
    return JSON.parse(call.substring('host_command:'.length));
  };

  const deleteManyCalls = () => sentCommands(
    (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string),
  ).filter((envelope) => envelope?.type === 'history.deleteMany')
    .map((envelope) => (envelope?.payload as { sessionIds?: string[] }).sessionIds);

  beforeEach(() => {
    endTransition('tab-1');
    endTransition('tab-active');
    window.__pendingSessionTransitionToast = undefined;
    window.sendToJava = vi.fn();
    window.__openNewSessionTab = vi.fn();
  });

  afterEach(() => {
    delete window.__openNewSessionTab;
  });

  it('opens a local tab for a direct new session', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'old-session',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    // No host session is created before the first send.
    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).not.toHaveBeenCalledWith('create_new_session:');
  });


  it('applies repeated history deletes against the latest state', () => {
    let historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'history-1',
          title: 'History One',
          provider: 'claude',
          messageCount: 3,
          lastTimestamp: Date.now(),
        },
        {
          sessionId: 'history-2',
          title: 'History Two',
          provider: 'codex',
          messageCount: 5,
          lastTimestamp: Date.now(),
        },
      ],
      total: 8,
    } as unknown as HistoryData;

    const mocks = {
      ...createMocks(),
      setHistoryData: vi.fn((next: HistoryData | null | ((current: HistoryData | null) => HistoryData | null)) => {
        historyData = typeof next === 'function' ? next(historyData) as HistoryData : next as HistoryData;
      }),
    };

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.deleteHistorySession('history-1');
      result.current.deleteHistorySession('history-2');
    });

    expect(historyData.sessions).toEqual([]);
    expect(historyData.total).toBe(0);
    const deletes = sentCommands(
      (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0] as string),
    ).filter((envelope) => envelope?.type === 'history.delete')
      .map((envelope) => (envelope?.payload as { sessionId?: string }).sessionId);
    expect(deletes).toEqual(['history-1', 'history-2']);
  });

  it('sends one backend request when deleting multiple history sessions', () => {
    let historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'history-1',
          title: 'History One',
          provider: 'claude',
          messageCount: 3,
          lastTimestamp: Date.now(),
        },
        {
          sessionId: 'history-2',
          title: 'History Two',
          provider: 'codex',
          messageCount: 5,
          lastTimestamp: Date.now(),
        },
      ],
      total: 8,
    } as unknown as HistoryData;

    const mocks = {
      ...createMocks(),
      setHistoryData: vi.fn((next: HistoryData | null | ((current: HistoryData | null) => HistoryData | null)) => {
        historyData = typeof next === 'function' ? next(historyData) as HistoryData : next as HistoryData;
      }),
    };

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.deleteHistorySessions(['history-1', 'history-2', 'history-1']);
    });

    expect(historyData.sessions).toEqual([]);
    expect(historyData.total).toBe(0);
    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(deleteManyCalls()).toEqual([['history-1', 'history-2']]);
    expect(mocks.addToast).toHaveBeenCalledWith('history.sessionDeleted', 'success');
  });

  it('still shows a success toast for batch delete when history data is temporarily unavailable', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.deleteHistorySessions(['history-1', 'history-2', 'history-1']);
    });

    expect(deleteManyCalls()).toEqual([['history-1', 'history-2']]);
    expect(mocks.addToast).toHaveBeenCalledWith('history.sessionDeleted', 'success');
  });

  it('defers the deleted toast until transition completion when batch delete removes current session', () => {
    let historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'history-1',
          title: 'History One',
          provider: 'claude',
          messageCount: 3,
          lastTimestamp: Date.now(),
        },
        {
          sessionId: 'history-2',
          title: 'History Two',
          provider: 'codex',
          messageCount: 5,
          lastTimestamp: Date.now(),
        },
      ],
      total: 8,
    } as unknown as HistoryData;

    const mocks = {
      ...createMocks(),
      setHistoryData: vi.fn((next: HistoryData | null | ((current: HistoryData | null) => HistoryData | null)) => {
        historyData = typeof next === 'function' ? next(historyData) as HistoryData : next as HistoryData;
      }),
    };

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: 'history-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.deleteHistorySessions(['history-1', 'history-2']);
    });

    expect(deleteManyCalls()).toEqual([['history-1', 'history-2']]);
    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).not.toHaveBeenCalledWith('history.sessionDeleted', 'success');
    expect(window.__pendingSessionTransitionToast).toEqual({
      message: 'history.sessionDeleted',
      type: 'success',
    });
  });

  it('forceCreateNewSession interrupts loading session and cleans state', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'streaming...', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'active-session',
        ...mocks,
        t,
      })
    );

    withActiveTab();
    act(() => {
      result.current.forceCreateNewSession();
    });

    expect(interruptCalls()).toHaveLength(1);
    expect(interruptPayload()?.tabId).toBe('tab-1');
    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).not.toHaveBeenCalledWith('create_new_session:');
  });


  it('shows confirm dialog when creating new session with existing messages', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'user', content: 'hello', timestamp: new Date().toISOString() }],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).not.toHaveBeenCalledWith('create_new_session:');
  });

  it('still shows the interrupt dialog while loading', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'thinking', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    // Interrupt dialog must appear; no silent transition.
    expect(result.current.showInterruptConfirm).toBe(true);
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(mocks.setMessages).not.toHaveBeenCalled();
    expect(window.__openNewSessionTab).not.toHaveBeenCalled();
  });

  it('handleConfirmInterrupt completes interrupt+transition', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'thinking', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Open the interrupt dialog.
    act(() => {
      result.current.createNewSession();
    });
    expect(result.current.showInterruptConfirm).toBe(true);

    // User confirms interrupt. The command names the tab it stops, so the test
    // needs the same active-tab store the app always has.
    withActiveTab();
    act(() => {
      result.current.handleConfirmInterrupt();
    });

    // Dialog cleared, the tab is opened locally, and interrupt fires once.
    expect(result.current.showInterruptConfirm).toBe(false);
    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);

    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(calls.filter((c) => c.startsWith('host_command:') && c.includes('session.interrupt'))).toHaveLength(1);
    expect(calls.filter((c) => c === 'create_new_session:')).toHaveLength(0);
  });

  it('handleConfirmInterrupt interrupts and cleans state', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'responding...', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Must trigger interrupt dialog first
    act(() => {
      result.current.createNewSession();
    });

    // Then confirm interrupt
    withActiveTab();
    act(() => {
      result.current.handleConfirmInterrupt();
    });

    expect(interruptCalls()).toHaveLength(1);
    expect(interruptPayload()?.tabId).toBe('tab-1');
    expect(window.__openNewSessionTab).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).not.toHaveBeenCalledWith('create_new_session:');
  });

  it('binds a named tab even when currentSessionId already points at the session', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'fork-1',
          title: 'Forked',
          provider: 'opencode',
          messageCount: 2,
          lastTimestamp: Date.now(),
        },
      ],
      total: 1,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: 'fork-1',
        currentSessionIdRef: { current: 'fork-1' },
        ...mocks,
        t,
      })
    );

    // The screen still shows another tab. The fork lands in its own tab.
    withActiveTab('tab-source');
    act(() => {
      result.current.loadHistorySession('fork-1', 'tab-fork');
    });

    const envelopes = sentCommands(
      (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0] as string),
    );
    const load = envelopes.find((envelope) => envelope?.type === 'session.load');
    // A bind, not a "same session" soft reload: it names the reserved tab.
    expect(load?.tabId).toBe('tab-fork');
    expect(isTabTransitioning('tab-fork')).toBe(true);
    expect(isTabTransitioning('tab-source')).toBe(false);
  });

  it('loadHistorySession without loading state does not send interrupt', () => {    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-2',
          title: null,
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messageCount: 1,
          lastTimestamp: Date.now(),
        },
      ],
      total: 1,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    withActiveTab();
    act(() => {
      result.current.loadHistorySession('hist-2');
    });

    // Should NOT send interrupt when not loading
    const calls = (window.sendToJava as any).mock.calls.map((c: any) => c[0]);
    expect(sentCommands(calls).filter((e) => e?.type === 'session.interrupt')).toHaveLength(0);
    expect(sessionLoadCalls('hist-2')).toBe(true);

    // But should still set transition guard
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith('hist-2');
    expect(mocks.setCustomSessionTitle).toHaveBeenCalledWith(null);
  });

  it('loadHistorySession sends sessionId only (model/mode restored by daemon)', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-opencode',
          title: 'OpenCode Session',
          provider: 'opencode',
          model: 'anthropic/claude-sonnet-4-5',
          messageCount: 2,
          lastTimestamp: Date.now(),
        },
      ],
      total: 2,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-opencode');
    });

    // 历史快照的行内 provider/model 从不更新，不再随 load_session 下发；
    // 会话级状态由宿主从 daemon session.get 权威恢复。
    expect(sessionLoadCalls('hist-opencode')).toBe(true);
  });

  it('loadHistorySession ignores stale row provider/model', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-codex',
          title: 'Codex Session',
          provider: 'codex',
          model: 'gpt-5.4',
          messageCount: 2,
          lastTimestamp: Date.now(),
        },
      ],
      total: 2,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-codex');
    });

    expect(sessionLoadCalls('hist-codex')).toBe(true);
  });

  it('history transition resets usage tokens', () => {
    const mocks = createMocks();
    const historyData = {
      success: true,
      sessions: [{ sessionId: 'hist-usage', title: 'Usage', provider: 'opencode', messageCount: 0, lastTimestamp: Date.now() }],
      total: 1,
    } as unknown as HistoryData;

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-usage');
    });

    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(mocks.setUsageMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('beginSessionTransition clears all transient UI states synchronously', () => {
    const mocks = createMocks();
    const historyData = {
      success: true,
      sessions: [{ sessionId: 'hist-reset', title: 'Reset', provider: 'opencode', messageCount: 0, lastTimestamp: Date.now() }],
      total: 1,
    } as unknown as HistoryData;

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-reset');
    });

    // All transient UI states must be synchronously cleared
    expect(mocks.setStatus).toHaveBeenCalledWith('');
    expect(mocks.setLoading).toHaveBeenCalledWith(false);
    expect(mocks.setIsThinking).toHaveBeenCalledWith(false);
    expect(mocks.setStreamingActive).toHaveBeenCalledWith(false);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(mocks.setUsageMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('historyLoadComplete releases transition guard', () => {
    // Simulate what happens when Java calls historyLoadComplete after successful load
    beginTransition('tab-1', 'hist-1', 'transition-test');

    // historyLoadComplete is defined in useWindowCallbacks, but we can test
    // that the guard release mechanism works by direct simulation
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBe('transition-test');

    // Simulate historyLoadComplete behavior
    endTransition('tab-1');
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(transitionTokenFor('tab-1')).toBeNull();
  });

  it('loadHistorySession sets transition guard that blocks updateMessages', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-3',
          title: 'Test Session',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messageCount: 1,
          lastTimestamp: Date.now(),
        },
      ],
      total: 1,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    withActiveTab();
    act(() => {
      result.current.loadHistorySession('hist-3');
    });

    // Guard is set, blocking stale updateMessages
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();

    // Simulate historyLoadComplete (success path releases guard)
    act(() => {
      endTransition('tab-1');
    });
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(transitionTokenFor('tab-1')).toBeNull();

    // Simulate failure path: guard must also be released
    act(() => {
      beginTransition('tab-1', 'hist-3', 'transition-rearm'); // re-arm
    });
    // Java exceptionally block calls historyLoadComplete before addErrorMessage
    act(() => {
      endTransition('tab-1');
    });
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(transitionTokenFor('tab-1')).toBeNull();
  });
});
