// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from './useSessionTabs';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeMessage } from '../types';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
  sendTypedBridgeEvent: vi.fn(),
}));

/**
 * 「全局至多一个 sessionId 为 null 的新对话」。
 *
 * 单实例之后标签列表是全局的（宿主 `ChatTabStore` + `apply_tabs` 广播），
 * 这条不变量只剩视图内一处需要守：`createTab()` 已经存在草稿时必须切过去，
 * 而不是再 push 一个空会话。
 */
describe('useSessionTabs - draft guard', () => {
  const mockT = ((key: string, opts?: any) => opts?.defaultValue || key) as any;
  const dummyFn = vi.fn();
  const emptyMessages: ClaudeMessage[] = [];

  // `saveCurrentTabSnapshot` 会把 currentSessionId 回写到当前标签，所以这里
  // 必须用真实 state 驱动，否则绑定会被下一次快照擦成 null。
  const renderTabs = () =>
    renderHook(() => {
      const [sessionId, setSessionId] = useState<string | null>(null);
      return useSessionTabs({
        currentSessionId: sessionId,
        setCurrentSessionId: setSessionId,
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
      } as any);
    });

  const store = () => window.__sessionTabsStore!;

  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__sessionTabsStore;
    delete window.__dialogStore;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    delete window.__dialogStore;
  });

  it('selects the existing unbound tab instead of creating another', () => {
    const { result } = renderTabs();

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });
    expect(result.current.tabs).toHaveLength(2);
    const draftId = result.current.tabs[1].id;
    expect(result.current.tabs[1].sessionId).toBeNull();

    // 回到已绑定的标签，再点一次「新建对话」
    act(() => {
      result.current.selectTab('tab-1');
    });
    act(() => {
      result.current.createTab();
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(store().getActiveTabId()).toBe(draftId);
  });

  it('creates a draft when the view has none left', () => {
    const { result } = renderTabs();

    act(() => {
      store().updateTabSessionId('tab-1', 'ses_a');
    });
    act(() => {
      result.current.createTab();
    });

    expect(result.current.tabs).toHaveLength(2);
    const active = result.current.tabs.find((tab) => tab.id === store().getActiveTabId());
    expect(active?.sessionId).toBeNull();
  });

  it('handshakes with the host before publishing the local tab list', () => {
    renderTabs();

    const calls = (sendBridgeEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.filter((call) => call[0] === 'get_tabs')).toHaveLength(1);
    // 宿主回包前不允许上行，否则会用本地种子覆盖别的窗口已经同步过的列表。
    expect(calls.filter((call) => call[0] === 'sync_tabs')).toHaveLength(0);
  });
});
