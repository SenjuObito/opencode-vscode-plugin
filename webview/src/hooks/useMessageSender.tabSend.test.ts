/**
 * 发送路径的 tab 身份（P8-A3）。
 *
 * 多 tab 后发送必须带 tabId：宿主按 tabId 解析目标会话，否则 B 的输入会落到
 * 当前活跃会话上。本文件单独成篇（不用 useMessageSender.context.test.ts），
 * 因为需要把 tabStore 打成「有活跃 tab」，而那个文件断言的是无 tab 时的 legacy 兜底。
 */
import { act, renderHook } from '@testing-library/react';

vi.mock('../store/tabStore', () => ({
  getTabStore: () => ({
    getActiveTabId: () => 'tab-alpha',
    findIdBySession: () => null,
  }),
}));

import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - tab-scoped send', () => {
  const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as never;

  const createOptions = (): UseMessageSenderOptions => ({
    t,
    addToast: vi.fn(),
    currentProvider: 'opencode',
    selectedModel: 'opencode/gpt-5',
    permissionMode: 'default',
    reasoningEffort: 'high',
    daemonStatusLoaded: true,
    currentSdkInstalled: true,
    sentAttachmentsRef: { current: new Map() },
    chatInputRef: { current: null },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    isStreamingRef: { current: false },
    streamingContentRef: { current: '' },
    streamingThinkingRef: { current: '' },
    contentUpdateTimeoutRef: { current: null },
    thinkingUpdateTimeoutRef: { current: null },
    setMessages: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setStreamingActive: vi.fn(),
    setCurrentView: vi.fn(),
    forceCreateNewSession: vi.fn(),
    handleModeSelect: vi.fn(),
    openContextUsageDialog: vi.fn(),
    closeContextUsageDialog: vi.fn().mockReturnValue(true),
  });

  /** 取出所有 host_command 信封（按发送顺序）。 */
  const hostCommands = (): Array<Record<string, unknown>> => {
    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]));
    return calls
      .filter((payload) => payload.startsWith('host_command:'))
      .map((payload) => JSON.parse(payload.slice('host_command:'.length)) as Record<string, unknown>);
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('发送走 session.send，并带上是哪个 tab', () => {
    const { result } = renderHook(() => useMessageSender(createOptions()));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const commands = hostCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('session.send');
    expect(commands[0].tabId).toBe('tab-alpha');
    expect(commands[0].v).toBe(2);
    const payload = commands[0].payload as Record<string, unknown>;
    expect(payload.text).toBe('hello');
    expect(payload.reasoningEffort).toBe('high');
    expect(payload.permissionMode).toBe('default');
  });

  it('附件随 session.send 一起下发（仍走内联 base64，分块链路另开）', () => {
    const { result } = renderHook(() => useMessageSender(createOptions()));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const commands = hostCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('session.send');
    const payload = commands[0].payload as { attachments?: Array<{ data?: string }> };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments?.[0].data).toBe('aGVsbG8=');
  });
});
