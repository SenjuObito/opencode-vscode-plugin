// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from './useSessionTabs';
import type { ContextInfo } from './useWindowCallbacks';
import type { ClaudeMessage } from '../types';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
  sendTypedBridgeEvent: vi.fn(),
}));

/** 取出所有 refresh_editor_context 事件的 payload（按发送顺序）。 */
function editorContextRefreshes(): Array<{ tabId: string; enabled: boolean }> {
  return vi
    .mocked(sendBridgeEvent)
    .mock.calls.filter(([event]) => event === 'refresh_editor_context')
    .map(([, payload]) => JSON.parse(String(payload)));
}

describe('useSessionTabs - Context Decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockT = ((key: string, opts?: any) => opts?.defaultValue || key) as any;
  const staticEmptyMessages: ClaudeMessage[] = [];
  const dummyFn = vi.fn();

  it('does not wipe global contextInfo when active tab disables auto-open file', () => {
    const setContextInfo = vi.fn();
    const initialContextInfo: ContextInfo = { file: '/path/to/Main.java', raw: '@/path/to/Main.java' };

    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'session-1',
        sessionTitle: 'Session 1',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: staticEmptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        contextInfo: initialContextInfo,
        setContextInfo,
        defaultAutoOpenFileEnabled: true,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
      })
    );

    expect(result.current.activeTabAutoOpenFileEnabled).toBe(true);

    act(() => {
      result.current.setActiveTabAutoOpenFileEnabled(false);
    });

    expect(result.current.activeTabAutoOpenFileEnabled).toBe(false);
    // setContextInfo(null) must NOT be called; contextInfo remains preserved in environmental state
    expect(setContextInfo).not.toHaveBeenCalledWith(null);
  });

  it('re-syncs the editor context to the tab that becomes active after closing a tab', () => {
    let currentContextInfo: ContextInfo | null = { file: '/path/to/App.java', raw: '@/path/to/App.java' };
    const setContextInfo = vi.fn((info) => {
      currentContextInfo = info;
    });

    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'session-1',
        sessionTitle: 'Session 1',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: staticEmptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        contextInfo: currentContextInfo,
        setContextInfo,
        defaultAutoOpenFileEnabled: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
      })
    );

    // Turn ON auto-open on tab 1
    act(() => {
      result.current.setActiveTabAutoOpenFileEnabled(true);
    });
    expect(result.current.activeTabAutoOpenFileEnabled).toBe(true);

    // Create a new tab (defaultAutoOpenFileEnabled is false)
    act(() => {
      result.current.createTab();
    });

    const tabsAfterCreate = result.current.tabs;
    expect(tabsAfterCreate.length).toBe(2);
    const newTab = tabsAfterCreate[tabsAfterCreate.length - 1];
    expect(result.current.activeTabId).toBe(newTab.id);
    expect(result.current.activeTabAutoOpenFileEnabled).toBe(false);

    // 新 tab 先清掉上一个 tab 的 chip，再由宿主按本 tab 的开关决定是否补推
    expect(setContextInfo).toHaveBeenCalledWith(null);
    const afterCreate = editorContextRefreshes();
    expect(afterCreate[afterCreate.length - 1]).toEqual({ tabId: newTab.id, enabled: false });

    // Close the new tab, returning to previous tab (tab-1)
    act(() => {
      result.current.closeTab(newTab.id);
    });

    expect(result.current.activeTabId).toBe('tab-1');
    expect(result.current.activeTabAutoOpenFileEnabled).toBe(true);
    // 回到 tab-1 后同样清一次，再让宿主按 tab-1 的开关（开着）补推当前文件
    const afterClose = editorContextRefreshes();
    expect(afterClose[afterClose.length - 1]).toEqual({ tabId: 'tab-1', enabled: true });
  });

  it('claimUnboundTab prioritizes the currently active tab when multiple tabs are unbound', () => {
    const setCurrentSessionId = vi.fn();
    const currentSessionIdRef = { current: null as string | null };

    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: null,
        currentSessionIdRef,
        setCurrentSessionId,
        sessionTitle: null,
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: staticEmptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        contextInfo: null,
        setContextInfo: dummyFn,
        defaultAutoOpenFileEnabled: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        t: mockT,
      })
    );

    // Initial tab-1 is unbound (sessionId: null)
    expect(result.current.tabs.length).toBe(1);
    expect(result.current.tabs[0].sessionId).toBeNull();

    // Now suppose another tab is loaded or created, but active tab is set to tab-2
    // Simulate by invoking claimUnboundTab
    expect(window.__sessionTabsStore?.claimUnboundTab).toBeDefined();

    // Claim target session: should bind to tab-1 (the active tab)
    act(() => {
      const claimed = window.__sessionTabsStore!.claimUnboundTab!('session-active-123');
      expect(claimed).toBe(true);
    });

    expect(result.current.tabs[0].sessionId).toBe('session-active-123');
    expect(currentSessionIdRef.current).toBe('session-active-123');
    expect(setCurrentSessionId).toHaveBeenCalledWith('session-active-123');
  });

  it('scopes the new tab defaults to the new tab id instead of the window session', () => {
    // 裸值会被宿主当成「窗口当前会话」写进上一个 tab；新 tab 的默认值必须
    // 带上自己的 id，宿主持有的是以 tabId 为键的会话。
    const setSelectedModel = vi.fn();

    const { result } = renderHook(() =>
      useSessionTabs({
        currentSessionId: 'session-1',
        sessionTitle: 'Session 1',
        setCustomSessionTitle: dummyFn,
        updateHistoryTitle: dummyFn,
        messages: staticEmptyMessages,
        setMessages: dummyFn,
        loading: false,
        streamingActive: false,
        contextInfo: null,
        setContextInfo: dummyFn,
        defaultAutoOpenFileEnabled: false,
        isShared: false,
        forceCreateNewSession: dummyFn,
        loadHistorySession: dummyFn,
        setSelectedModel,
        availableModels: [
          { id: 'opencode/big-pickle', provider: 'opencode', name: 'big-pickle' },
        ] as never,
        currentProvider: 'opencode',
        t: mockT,
      })
    );

    act(() => {
      result.current.createTab();
    });

    const newTab = result.current.tabs[result.current.tabs.length - 1];
    const calls = vi.mocked(sendBridgeEvent).mock.calls;

    // 模型走 setSelectedModel（它内部才发 set_model），关键是带上新 tab 的 id。
    expect(setSelectedModel).toHaveBeenCalledWith('opencode/big-pickle', { sessionId: newTab.id });
    expect(calls.some(([event]) => event === 'set_model')).toBe(false);

    const modeCall = calls.find(([event]) => event === 'set_mode');
    const effortCall = calls.find(([event]) => event === 'set_reasoning_effort');
    expect(JSON.parse(String(modeCall?.[1]))).toEqual({
      sessionId: newTab.id,
      mode: 'default',
    });
    expect(JSON.parse(String(effortCall?.[1]))).toEqual({
      sessionId: newTab.id,
      reasoningEffort: 'default',
    });
  });
});

