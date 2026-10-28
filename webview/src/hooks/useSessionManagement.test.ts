import { act, renderHook } from '@testing-library/react';
import { useSessionManagement } from './useSessionManagement.js';
import { beginTransition, endTransition, isTabTransitioning, transitionTokenFor } from './windowCallbacks/tabTransition';
import { seedTabStore } from '../test/seedTabStore';
import type { HistoryData } from '../types/index.js';

/**
 * 新会话现在是 v2 `session.new` 命令（没有活跃 tab 时 envelope 的 tabId 为 null），
 * 不再是 legacy `create_new_session:` 文本消息。
 */
const newSessionCommandCount = (): number => {
  const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => String(c[0]));
  return calls.filter((payload) => {
    if (!payload.startsWith('host_command:')) return false;
    try {
      const envelope = JSON.parse(payload.slice('host_command:'.length)) as { type?: string };
      return envelope.type === 'session.new';
    } catch {
      return false;
    }
  }).length;
};

const expectNewSessionCommand = () => expect(newSessionCommandCount()).toBeGreaterThan(0);

/** 中断命令：v2 `session.interrupt`（有 tab 身份时不再走 legacy `interrupt_session:`）。 */
const interruptCalls = (): string[] => (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
  .map((c: unknown[]) => String(c[0]))
  .filter((payload: string) => payload.startsWith('host_command:') && payload.includes('session.interrupt'));

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

  beforeEach(() => {
    // The transition guard belongs to a tab, so every case needs one.
    seedTabStore([{ id: 'tab-1' }], 'tab-1');
    endTransition('tab-1');
    endTransition('tab-active');
    window.__pendingSessionTransitionToast = undefined;
    window.sendToJava = vi.fn();
    // Reset the "skip new-session confirm" preference between tests so cases
    // that exercise the localStorage path can't leak into ones that don't.
    localStorage.removeItem('skipNewSessionConfirm');
  });

  it('starts a clean session transition for a direct new session', () => {
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

    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setStatus).toHaveBeenCalledWith('');
    expect(mocks.setLoading).toHaveBeenCalledWith(false);
    expect(mocks.setIsThinking).toHaveBeenCalledWith(false);
    expect(mocks.setStreamingActive).toHaveBeenCalledWith(false);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(mocks.setCustomSessionTitle).toHaveBeenCalledWith(null);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expectNewSessionCommand();
  });

  it('calls onResetToPreferredModel when creating a new session', () => {
    const mocks = createMocks();
    const onResetToPreferredModel = vi.fn();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'old-session',
        onResetToPreferredModel,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    expect(onResetToPreferredModel).toHaveBeenCalledTimes(1);
    expectNewSessionCommand();
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
    expect(window.sendToJava).toHaveBeenCalledWith('delete_session:history-1');
    expect(window.sendToJava).toHaveBeenCalledWith('delete_session:history-2');
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
    expect(window.sendToJava).toHaveBeenCalledWith('delete_sessions:["history-1","history-2"]');
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

    expect(window.sendToJava).toHaveBeenCalledWith('delete_sessions:["history-1","history-2"]');
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

    expect(window.sendToJava).toHaveBeenCalledWith('delete_sessions:["history-1","history-2"]');
    expectNewSessionCommand();
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

    act(() => {
      result.current.forceCreateNewSession();
    });

    expect(interruptCalls()).toHaveLength(1);
    expectNewSessionCommand();
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
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

    // Should show confirm dialog, NOT immediately transition
    expect(result.current.showNewSessionConfirm).toBe(true);
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(transitionTokenFor('tab-1')).toBeNull();
    expect(mocks.setMessages).not.toHaveBeenCalled();
  });

  it('skips confirm dialog when skipNewSessionConfirm preference is enabled', () => {
    // User previously ticked "don't ask again" — dialog should be bypassed.
    localStorage.setItem('skipNewSessionConfirm', 'true');
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

    // Should transition immediately without showing the dialog.
    expect(result.current.showNewSessionConfirm).toBe(false);
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expectNewSessionCommand();
  });

  it('still shows the interrupt dialog while loading even if skipNewSessionConfirm is enabled', () => {
    // Safety guard: the "don't ask again" preference must NOT bypass the
    // dangerous "interrupt running AI" confirm dialog. (See AppDialogs comment.)
    localStorage.setItem('skipNewSessionConfirm', 'true');
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

    // Interrupt dialog must still appear; no silent transition.
    expect(result.current.showInterruptConfirm).toBe(true);
    expect(result.current.showNewSessionConfirm).toBe(false);
    expect(isTabTransitioning('tab-1')).toBe(false);
    expect(mocks.setMessages).not.toHaveBeenCalled();
    expect(newSessionCommandCount()).toBe(0);
  });

  it('handleConfirmInterrupt completes interrupt+transition even with skipNewSessionConfirm enabled', () => {
    // Regression guard: once the interrupt dialog is confirmed, the flow must
    // send interrupt_session + create_new_session exactly once. The skip
    // preference must not cause a second silent transition or skip the
    // interrupt signal.
    localStorage.setItem('skipNewSessionConfirm', 'true');
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

    // User confirms interrupt.
    act(() => {
      result.current.handleConfirmInterrupt();
    });

    // Dialog cleared, transition started, and BOTH bridge events fired exactly once.
    expect(result.current.showInterruptConfirm).toBe(false);
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.setMessages).toHaveBeenCalledWith([]);

    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(interruptCalls()).toHaveLength(1);
    expect(newSessionCommandCount()).toBe(1);
  });

  it('handleConfirmNewSession cleans state and creates new session', () => {
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

    // Trigger dialog first
    act(() => {
      result.current.createNewSession();
    });

    // Confirm
    act(() => {
      result.current.handleConfirmNewSession();
    });

    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expectNewSessionCommand();
    expect(result.current.showNewSessionConfirm).toBe(false);
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
    act(() => {
      result.current.handleConfirmInterrupt();
    });

    expect(interruptCalls()).toHaveLength(1);
    expectNewSessionCommand();
    expect(isTabTransitioning('tab-1')).toBe(true);
    expect(transitionTokenFor('tab-1')).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
  });

  it('loadHistorySession without loading state does not send interrupt', () => {
    const historyData = {
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

    act(() => {
      result.current.loadHistorySession('hist-2');
    });

    // Should NOT send interrupt when not loading
    const calls = (window.sendToJava as any).mock.calls.map((c: any) => c[0]);
    expect(interruptCalls()).toHaveLength(0);
    expect(calls).toContain(
      'load_session:{"sessionId":"hist-2"}',
    );

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
    expect(window.sendToJava).toHaveBeenCalledWith(
      'load_session:{"sessionId":"hist-opencode"}'
    );
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

    expect(window.sendToJava).toHaveBeenCalledWith(
      'load_session:{"sessionId":"hist-codex"}'
    );
  });

  it('all transition paths reset usage tokens', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Test forceCreateNewSession
    act(() => {
      result.current.forceCreateNewSession();
    });

    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(mocks.setUsageMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('beginSessionTransition clears all transient UI states synchronously', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.forceCreateNewSession();
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


