import { fireEvent, render } from '@testing-library/react';
import AgentGroupBlock from './AgentGroupBlock';

const mockSendSessionCommand = vi.fn();
let mockHistories: Record<string, unknown> = {};
const mockUseSessionId = vi.fn<() => string | null>();
const mockUseSessionProvider = vi.fn<() => string>();
const mockGetToolResultRaw = vi.fn<(toolUseId: string) => Record<string, unknown> | null>();
const mockUseTaskEvent = vi.fn<(toolUseId: string | undefined) => unknown>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  sendSessionCommand: (...args: unknown[]) => mockSendSessionCommand(...args),
}));

vi.mock('../../contexts/SubagentContext', () => ({
  useSubagentHistories: () => mockHistories,
  useSessionId: () => mockUseSessionId(),
  useSessionProvider: () => mockUseSessionProvider(),
  useGetToolResultRaw: () => mockGetToolResultRaw,
  useTaskEvent: (toolUseId: string | undefined) => mockUseTaskEvent(toolUseId),
}));

// The agent card only renders following text/tool blocks when expanded; these
// status tests carry none.
vi.mock('../MessageItem/ContentBlockRenderer', () => ({
  ContentBlockRenderer: () => null,
}));

const agentBlock = {
  type: 'tool_use' as const,
  id: 'subagent-1',
  name: 'subagent',
  input: { description: 'Explore repo', agent: 'explore' },
};

function renderGroup(result: unknown, overrides: Record<string, unknown> = {}) {
  return render(
    <AgentGroupBlock
      agentBlock={agentBlock}
      followingBlocks={[]}
      messageIndex={0}
      isStreaming={false}
      isLastMessage={false}
      isThinking={false}
      findToolResult={() => result as any}
      {...overrides}
    />,
  );
}

describe('AgentGroupBlock subagent status', () => {
  beforeEach(() => {
    mockSendSessionCommand.mockReset();
    mockGetToolResultRaw.mockReset();
    mockUseSessionId.mockReset();
    mockUseSessionProvider.mockReset();
    mockUseTaskEvent.mockReset();

    mockHistories = {};
    mockGetToolResultRaw.mockReturnValue(null);
    mockUseSessionId.mockReturnValue('session-1');
    mockUseSessionProvider.mockReturnValue('opencode');
    mockUseTaskEvent.mockReturnValue(undefined);
  });

  it('completes an inline agent even when a cached transcript still says running', () => {
    mockHistories = {
      'subagent-1': { success: true, status: 'running', completed: false, messages: [] },
    };

    const { container } = renderGroup({
      type: 'tool_result',
      tool_use_id: 'subagent-1',
      content: '<subagent sessionID="ses_child" state="completed">done</subagent>',
    });

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('completed');
    expect(indicator?.className).not.toContain('pending');
  });

  it('keeps an async launch pending regardless of its cached transcript', () => {
    mockHistories = {
      'subagent-1': { success: true, status: 'completed', completed: true, messages: [] },
    };

    const { container } = renderGroup({
      type: 'tool_result',
      tool_use_id: 'subagent-1',
      content: '<subagent sessionID="ses_child" state="running" description="Explore repo">…</subagent>',
    });

    // Only core's terminal event can complete a background launch.
    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('requests the transcript once per expansion and never uses it for status', () => {
    const result = {
      type: 'tool_result',
      tool_use_id: 'subagent-1',
      content: '<subagent sessionID="ses_child" state="completed">done</subagent>',
    };
    const rerenderGroup = (next: unknown) => (
      <AgentGroupBlock
        agentBlock={agentBlock}
        followingBlocks={[]}
        messageIndex={0}
        isStreaming={false}
        isLastMessage={false}
        isThinking={false}
        findToolResult={() => next as any}
      />
    );

    const { container, rerender } = renderGroup(null);
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    expect(mockSendSessionCommand).toHaveBeenCalledTimes(1);

    // The expand-time answer is a snapshot taken while the child still ran; it
    // must not by itself schedule another read.
    mockHistories = {
      'subagent-1': { success: true, status: 'running', completed: false, messages: [] },
    };
    mockSendSessionCommand.mockClear();
    rerender(rerenderGroup(null));
    expect(mockSendSessionCommand).not.toHaveBeenCalled();

    // The terminal report lands as the parent tool_result; status comes from
    // that (or core's event), so the transcript is not re-read.
    rerender(rerenderGroup(result));
    expect(mockSendSessionCommand).not.toHaveBeenCalled();
    expect(container.querySelector('.tool-status-indicator')?.className).toContain('completed');

    rerender(rerenderGroup(result));
    expect(mockSendSessionCommand).not.toHaveBeenCalled();
  });
});
