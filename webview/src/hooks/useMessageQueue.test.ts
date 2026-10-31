// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageQueue } from './useMessageQueue';
import { getTabStore, resetTabStore } from '../store/tabStore';
import type { SessionTabData } from '../components/ChatHeader/types';

const bridgeMocks = vi.hoisted(() => ({
  sendTabCommand: vi.fn(),
}));

vi.mock('../utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/bridge')>();
  return {
    ...actual,
    sendTabCommand: (tabId: string, command: string, payload: Record<string, unknown> = {}) => {
      bridgeMocks.sendTabCommand(tabId, command, payload);
      return true;
    },
  };
});

function tab(id: string, sessionId: string | null = null): SessionTabData {
  return {
    id,
    sessionId,
    title: id,
    messages: [],
  };
}

function seedTabs(active: string, ...ids: string[]): void {
  const store = getTabStore();
  store.setTabs(ids.map((id) => tab(id, id === active ? `session-${id}` : null)));
  store.setActiveTabId(active);
}

describe('useMessageQueue', () => {
  beforeEach(() => {
    resetTabStore();
    bridgeMocks.sendTabCommand.mockClear();
  });

  it('starts empty and reads the active tab projection', () => {
    seedTabs('tab-a', 'tab-a');
    const { result } = renderHook(() => useMessageQueue());

    expect(result.current.queue).toEqual([]);
    expect(result.current.paused).toBe(false);
  });

  it('freezes the send and hands it to the host instead of sending itself', () => {
    seedTabs('tab-a', 'tab-a');
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue({
        content: 'Hello world',
        attachments: [{ attachmentId: 'a1', fileName: 'x.png', mediaType: 'image/png' }],
        fileTags: [{ displayPath: 'src/a.ts', absolutePath: 'D:/w/src/a.ts' }],
        model: 'openai/gpt-5',
        permissionMode: 'plan',
        reasoningEffort: 'high',
      });
    });

    expect(bridgeMocks.sendTabCommand).toHaveBeenCalledTimes(1);
    const [tabId, command, payload] = bridgeMocks.sendTabCommand.mock.calls[0];
    expect(tabId).toBe('tab-a');
    expect(command).toBe('queue.enqueue');
    const item = (payload as { item: Record<string, unknown> }).item;
    expect(item.text).toBe('Hello world');
    expect(item.model).toBe('openai/gpt-5');
    expect(item.permissionMode).toBe('plan');
    expect(item.reasoningEffort).toBe('high');
    expect(item.attachments).toEqual([
      { attachmentId: 'a1', fileName: 'x.png', mediaType: 'image/png' },
    ]);
    expect(item.fileTags).toEqual([
      { displayPath: 'src/a.ts', absolutePath: 'D:/w/src/a.ts' },
    ]);
    expect(typeof item.id).toBe('string');

    // The host owns the queue: the view did not add anything locally.
    expect(result.current.queue).toEqual([]);
  });

  it('hands a builtin session command to the same FIFO with frozen arguments', () => {
    seedTabs('tab-a', 'tab-a');
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueueCommand('/undo', { messageId: 'msg_1' });
      result.current.enqueueCommand('/compact', { model: 'openai/gpt-5' });
    });

    const first = (bridgeMocks.sendTabCommand.mock.calls[0][2] as {
      item: Record<string, unknown>;
    }).item;
    expect(bridgeMocks.sendTabCommand.mock.calls[0][0]).toBe('tab-a');
    expect(bridgeMocks.sendTabCommand.mock.calls[0][1]).toBe('queue.enqueue');
    expect(first.text).toBe('/undo');
    expect(first.command).toBe('/undo');
    expect(first.commandArgs).toEqual({ messageId: 'msg_1' });
    expect(first.attachments).toEqual([]);

    const second = (bridgeMocks.sendTabCommand.mock.calls[1][2] as {
      item: Record<string, unknown>;
    }).item;
    expect(second.command).toBe('/compact');
    expect(second.model).toBe('openai/gpt-5');

    // The view never adds a command locally: the host owns the queue.
    expect(result.current.queue).toEqual([]);
  });

  it('renders the snapshot the host pushes for the active tab', () => {
    seedTabs('tab-a', 'tab-a');
    const store = getTabStore();
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      store.updateTab('tab-a', (current) => {
        current.queue = {
          items: [{ id: 'q1', content: 'queued', createdAt: 1 }],
          paused: true,
          lastError: { itemId: 'q1', message: 'boom' },
        };
      });
    });

    expect(result.current.queue.map((item) => item.id)).toEqual(['q1']);
    expect(result.current.paused).toBe(true);
    expect(result.current.lastError?.message).toBe('boom');
  });

  it('addresses remove/clear/resume to the tab on screen only', () => {
    seedTabs('tab-a', 'tab-a', 'tab-b');
    const store = getTabStore();
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.dequeue('q1');
      result.current.clearQueue();
      result.current.resumeQueue();
    });

    expect(bridgeMocks.sendTabCommand.mock.calls).toEqual([
      ['tab-a', 'queue.remove', { itemId: 'q1' }],
      ['tab-a', 'queue.clear', {}],
      ['tab-a', 'queue.resume', {}],
    ]);

    bridgeMocks.sendTabCommand.mockClear();
    act(() => {
      store.setActiveTabId('tab-b');
    });
    act(() => {
      result.current.enqueue({ content: 'for b' });
    });

    expect(bridgeMocks.sendTabCommand.mock.calls[0][0]).toBe('tab-b');
    expect(bridgeMocks.sendTabCommand.mock.calls[0][1]).toBe('queue.enqueue');
  });

  it('switching tabs changes only what is displayed', () => {
    seedTabs('tab-a', 'tab-a', 'tab-b');
    const store = getTabStore();
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      store.updateTab('tab-a', (current) => {
        current.queue = {
          items: [{ id: 'a-1', content: 'A item', createdAt: 1 }],
          paused: false,
          lastError: null,
        };
      });
      store.updateTab('tab-b', (current) => {
        current.queue = {
          items: [{ id: 'b-1', content: 'B item', createdAt: 1 }],
          paused: false,
          lastError: null,
        };
      });
    });

    expect(result.current.queue.map((item) => item.id)).toEqual(['a-1']);

    act(() => {
      store.setActiveTabId('tab-b');
    });
    expect(result.current.queue.map((item) => item.id)).toEqual(['b-1']);

    act(() => {
      store.setActiveTabId('tab-a');
    });
    // A's queue was never touched by the switch.
    expect(result.current.queue.map((item) => item.id)).toEqual(['a-1']);
  });
});
