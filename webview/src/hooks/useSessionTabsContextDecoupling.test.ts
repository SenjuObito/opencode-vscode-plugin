// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from './useSessionTabs';
import type { ContextInfo } from './useWindowCallbacks';
import type { ClaudeMessage } from '../types';
import { resetTabStore } from '../store/tabStore';

vi.mock('../utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/bridge')>();
  return {
    ...actual,
    sendBridgeEvent: vi.fn(),
    sendTabCommand: vi.fn(),
  };
});

describe('useSessionTabs - Context Decoupling', () => {
  beforeEach(() => {
    // Every test starts with an empty tab strip.
    resetTabStore();
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

  it('preserves contextInfo when creating a new tab (auto-open disabled) and closing it to return to previous tab', () => {
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

    // Close the new tab, returning to previous tab (tab-1)
    act(() => {
      result.current.closeTab(newTab.id);
    });

    expect(result.current.activeTabId).toBe('tab-1');
    expect(result.current.activeTabAutoOpenFileEnabled).toBe(true);
    // Crucial check: setContextInfo(null) must NOT have been called to wipe the environment
    expect(setContextInfo).not.toHaveBeenCalledWith(null);
  });

});

