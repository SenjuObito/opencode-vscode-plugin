import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessagesProvider, useMessages, DEFAULT_STATUS } from './MessagesContext';
import { getTabStore, resetTabStore } from '../store/tabStore';
import type { SessionTabData } from '../components/ChatHeader/types';
import type { ClaudeMessage } from '../types';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MessagesProvider>{children}</MessagesProvider>
);

describe('MessagesContext', () => {
  beforeEach(() => {
    resetTabStore();
  });

  it('throws when useMessages is used outside MessagesProvider', () => {
    expect(() => renderHook(() => useMessages())).toThrow(/MessagesProvider/);
  });

  it('exposes default values inside the provider', () => {
    const { result } = renderHook(() => useMessages(), { wrapper });
    expect(result.current.messages).toEqual([]);
    expect(result.current.subagentHistories).toEqual({});
    expect(result.current.status).toBe(DEFAULT_STATUS);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadingStartTime).toBeNull();
    expect(result.current.isThinking).toBe(false);
    expect(result.current.streamingActive).toBe(false);
    expect(result.current.turnActive).toBe(false);
    expect(result.current.compactNotice).toBeNull();
  });

  it('updates messages via setMessages and reflects the new value', () => {
    const { result } = renderHook(() => useMessages(), { wrapper });
    const next: ClaudeMessage[] = [
      { type: 'user', content: 'hello', timestamp: '2026-05-07T00:00:00.000Z' },
    ];
    act(() => {
      result.current.setMessages(next);
    });
    expect(result.current.messages).toEqual(next);
  });

  it('updates loading / streaming / thinking flags independently', () => {
    const { result } = renderHook(() => useMessages(), { wrapper });
    act(() => {
      result.current.setLoading(true);
      result.current.setStreamingActive(true);
      result.current.setIsThinking(true);
      result.current.setLoadingStartTime(123);
      result.current.setStatus('working');
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.streamingActive).toBe(true);
    expect(result.current.isThinking).toBe(true);
    expect(result.current.loadingStartTime).toBe(123);
    expect(result.current.status).toBe('working');
  });

  it('keeps turnActive true while either phase of the turn is still running', () => {
    const { result } = renderHook(() => useMessages(), { wrapper });

    act(() => {
      result.current.setLoading(false);
      result.current.setStreamingActive(true);
    });
    expect(result.current.turnActive).toBe(true);

    act(() => {
      result.current.setLoading(true);
      result.current.setStreamingActive(false);
    });
    expect(result.current.turnActive).toBe(true);

    act(() => {
      result.current.setLoading(false);
      result.current.setStreamingActive(false);
    });
    expect(result.current.turnActive).toBe(false);
  });

  it('reads turn state from the active tab and follows a tab switch', () => {
    const tab = (id: string, turn: Partial<SessionTabData>): SessionTabData => ({
      id,
      sessionId: null,
      title: id,
      messages: [],
      ...turn,
    });
    const store = getTabStore();
    store.setTabs([
      tab('tab-1', { loading: true, streamingActive: false }),
      tab('tab-2', { loading: false, streamingActive: true }),
    ]);
    store.setActiveTabId('tab-1');

    const { result } = renderHook(() => useMessages(), { wrapper });
    expect(result.current.loading).toBe(true);
    expect(result.current.streamingActive).toBe(false);
    expect(result.current.turnActive).toBe(true);

    act(() => {
      store.setActiveTabId('tab-2');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.streamingActive).toBe(true);
    expect(result.current.turnActive).toBe(true);

    act(() => {
      result.current.setStreamingActive(false);
    });
    expect(result.current.turnActive).toBe(false);
    expect(store.findById('tab-1')?.loading).toBe(true);
  });

  it('keeps compactNotice on its tab until cleared', () => {
    const store = getTabStore();
    store.setTabs([
      { id: 'tab-1', sessionId: null, title: 'tab-1', messages: [] },
      { id: 'tab-2', sessionId: null, title: 'tab-2', messages: [] },
    ]);
    store.setActiveTabId('tab-1');

    const { result } = renderHook(() => useMessages(), { wrapper });
    const notice = { status: 'success' as const, at: 1 };
    act(() => {
      result.current.setCompactNotice(notice);
    });
    expect(result.current.compactNotice).toEqual(notice);
    expect(store.findById('tab-1')?.compactNotice).toEqual(notice);

    act(() => {
      store.setActiveTabId('tab-2');
    });
    expect(result.current.compactNotice).toBeNull();

    act(() => {
      store.setActiveTabId('tab-1');
    });
    expect(result.current.compactNotice).toEqual(notice);

    act(() => {
      result.current.setCompactNotice(null);
    });
    expect(store.findById('tab-1')?.compactNotice).toBeNull();
  });

  it('updates subagentHistories with functional setter', () => {
    const { result } = renderHook(() => useMessages(), { wrapper });
    act(() => {
      result.current.setSubagentHistories((prev) => ({
        ...prev,
        'tool-1': { messages: [] } as never,
      }));
    });
    expect(result.current.subagentHistories['tool-1']).toBeDefined();
  });

  it('returns stable setter references across renders', () => {
    const { result, rerender } = renderHook(() => useMessages(), { wrapper });
    const firstSetters = {
      setMessages: result.current.setMessages,
      setLoading: result.current.setLoading,
      setStreamingActive: result.current.setStreamingActive,
    };
    rerender();
    expect(result.current.setMessages).toBe(firstSetters.setMessages);
    expect(result.current.setLoading).toBe(firstSetters.setLoading);
    expect(result.current.setStreamingActive).toBe(firstSetters.setStreamingActive);
  });
});
