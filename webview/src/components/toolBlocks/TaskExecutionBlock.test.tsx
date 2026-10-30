import { act, fireEvent, render } from '@testing-library/react';
import TaskExecutionBlock from './TaskExecutionBlock';

const mockSendBridgeEvent = vi.fn();
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
  sendBridgeEvent: (...args: unknown[]) => mockSendBridgeEvent(...args),
}));

vi.mock('../../contexts/SubagentContext', () => ({
  useSubagentHistories: () => mockHistories,
  useSessionId: () => mockUseSessionId(),
  useSessionProvider: () => mockUseSessionProvider(),
  useGetToolResultRaw: () => mockGetToolResultRaw,
  useTaskEvent: (toolUseId: string | undefined) => mockUseTaskEvent(toolUseId),
}));

describe('TaskExecutionBlock subagent status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSendBridgeEvent.mockReset();
    mockGetToolResultRaw.mockReset();
    mockUseSessionId.mockReset();
    mockUseSessionProvider.mockReset();
    mockUseTaskEvent.mockReset();

    mockHistories = {};
    mockGetToolResultRaw.mockReturnValue(null);
    mockUseSessionId.mockReturnValue('session-1');
    mockUseSessionProvider.mockReturnValue('claude');
    mockUseTaskEvent.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the transcript once on expand without starting a status poll', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="task-1"
        isStreaming={false}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
          run_in_background: true,
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(mockSendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      expect.stringContaining('"toolUseId":"task-1"'),
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('expands the task details when the header is clicked', () => {
    const { container } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    expect(container.querySelector('.task-details')).toBeNull();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details')).toBeTruthy();
  });

  it('does not poll again after the transcript request resolves', () => {
    const { container } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={true}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(mockSendBridgeEvent).toHaveBeenCalledTimes(1);

    mockSendBridgeEvent.mockClear();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(mockSendBridgeEvent).not.toHaveBeenCalled();
  });

  it('keeps an async agent pending until its task_notification lands', () => {
    mockUseTaskEvent.mockReturnValue(undefined);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    // Launch ack tool_result is present, but async agents must NOT flip to
    // completed on it alone.
    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('keeps an unfinished async agent pending after history reload', () => {
    mockUseTaskEvent.mockReturnValue(undefined);
    mockHistories = { 'agent-async': { success: true, completed: false, messages: [] } };

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('does not treat a completed transcript snapshot as the run status', () => {
    // The transcript is detail-only: a snapshot read while the child was still
    // running must not drive the card. Only core's `subagent.status` completes
    // the run.
    mockUseTaskEvent.mockReturnValue(undefined);
    mockHistories = { 'agent-async': { success: true, completed: true, messages: [] } };

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('flips an async agent to completed when a task_notification arrives', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-async',
      status: 'completed',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('completed');
  });

  it('shows the error indicator when a task_notification reports failure', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-fail',
      status: 'failed',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-fail"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('error');
  });

  it('marks an async agent as errored when the launch tool_result reports is_error', () => {
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits a
    // task_notification - the card must show error, not stay "pending".
    mockUseTaskEvent.mockReturnValue(undefined);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-launch-fail"
        isStreaming={true}
        result={{ type: 'tool_result', tool_use_id: 'agent-launch-fail', content: 'Agent Teams is not available', is_error: true } as any}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('error');
    expect(indicator?.className).not.toContain('pending');
  });

  it('never starts a poll for a failed async agent', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-poll-fail',
      status: 'failed',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-poll-fail"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(container.querySelector('.tool-status-indicator')?.className).toContain('error');
  });

  it('renders an opencode v2 subagent card and completes it from subagent.status', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'subagent-v2',
      status: 'completed',
      summary: '没有找到',
      agentId: 'ses_child',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="subagent"
        toolId="subagent-v2"
        isStreaming={false}
        input={{
          agent: 'explore',
          description: '查找 liyibo',
          prompt: '在仓库中查找 liyibo',
          background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('completed');
    expect(container.textContent).toContain('explore');
  });

  it('renders task_event usage in SubagentProcessDetails for a completed async agent', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-usage',
      status: 'completed',
      totalTokens: 4200,
      totalToolUseCount: 7,
      totalDurationMs: 18000,
      summary: '调研完成',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-usage"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    const stats = container.querySelector('.subagent-process-stats');
    expect(stats).toBeTruthy();
    expect(stats?.textContent).toContain('7');
    expect(stats?.textContent).toContain('4,200');
    expect(container.querySelector('.subagent-result-card')?.textContent).toContain('调研完成');
  });

  it('parses spawn_agent meta (nickname, model, reasoning effort) from result text', () => {
    mockUseTaskEvent.mockReturnValue(undefined);
    mockGetToolResultRaw.mockReturnValue(null);

    const result = {
      type: 'tool_result',
      tool_use_id: 'spawn-1',
      content: '{"agent_id":"af5a83aa","nickname":"researcher","model":"claude-sonnet-4-6","reasoning_effort":"high"}',
    } as any;

    const { container } = render(
      <TaskExecutionBlock
        name="spawn_agent"
        toolId="spawn-1"
        result={result}
        input={{ prompt: 'do research' } as any}
      />,
    );

    const summaries = container.querySelectorAll('.tool-title-summary');
    const text = Array.from(summaries).map((el) => el.textContent).join(' ');
    expect(text).toContain('researcher');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('high');
  });

  it('loads Codex spawn_agent history with provider and task path', () => {
    mockUseSessionProvider.mockReturnValue('codex');
    const result = {
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: '{"task_name":"/root/reviewer"}',
    } as any;

    const { container } = render(
      <TaskExecutionBlock
        name="spawn_agent"
        toolId="call-1"
        result={result}
        input={{ prompt: 'review' } as any}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        agentPath: '/root/reviewer',
        toolUseId: 'call-1',
      }),
    );
    expect(container.querySelector('.tool-status-indicator')?.className).toContain('pending');
  });
});
