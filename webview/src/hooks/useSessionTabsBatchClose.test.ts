// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from './useSessionTabs';
import { resetTabStore } from '../store/tabStore';
import type { ClaudeMessage } from '../types';

const bridgeMocks = vi.hoisted(() => ({
  sendBridgeEvent: vi.fn(),
  sendTabCommand: vi.fn(),
}));

vi.mock('../utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/bridge')>();
  return {
    ...actual,
    sendBridgeEvent: bridgeMocks.sendBridgeEvent,
    sendTabCommand: (tabId: string, command: string, payload: Record<string, unknown> = {}) => {
      bridgeMocks.sendTabCommand(tabId, command, payload);
    },
    sendHostCommand: vi.fn(),
  };
});

describe('useSessionTabs batch close operations', () => {
  const mockT = ((key: string, opts?: any) => opts?.defaultValue || key) as any;
  const dummyFn = vi.fn();
  const emptyMessages: ClaudeMessage[] = [];

  beforeEach(() => {
    resetTabStore();
    bridgeMocks.sendBridgeEvent.mockClear();
    bridgeMocks.sendTabCommand.mockClear();
  });

  const setupThreeTabs = () => {
    const { result } = renderHook(() =>
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
      } as any)
    );

    act(() => {
      result.current.openSessionInTab('ses_1', '会话 1');
    });
    act(() => {
      result.current.openSessionInTab('ses_2', '会话 2');
    });
    act(() => {
      result.current.openSessionInTab('ses_3', '会话 3');
    });

    expect(result.current.tabs).toHaveLength(3);
    return result;
  };

  it('closeOtherTabs closes all tabs except the targeted one', () => {
    const result = setupThreeTabs();
    const [, tab1] = result.current.tabs;

    act(() => {
      result.current.closeOtherTabs(tab1.id);
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe(tab1.id);
    expect(result.current.activeTabId).toBe(tab1.id);
  });

  it('closeTabsToLeft closes tabs to the left of the targeted one', () => {
    const result = setupThreeTabs();
    const [, tab1, tab2] = result.current.tabs;

    act(() => {
      result.current.closeTabsToLeft(tab1.id);
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs.map((t) => t.id)).toEqual([tab1.id, tab2.id]);
  });

  it('closeTabsToRight closes tabs to the right of the targeted one', () => {
    const result = setupThreeTabs();
    const [tab0, tab1] = result.current.tabs;

    act(() => {
      result.current.closeTabsToRight(tab1.id);
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs.map((t) => t.id)).toEqual([tab0.id, tab1.id]);
  });

  it('closeAllTabs closes all tabs and creates a fresh empty session tab', () => {
    const result = setupThreeTabs();

    act(() => {
      result.current.closeAllTabs();
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].sessionId).toBeNull();
  });
});
