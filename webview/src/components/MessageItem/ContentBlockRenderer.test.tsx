import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { copyToClipboard } from '../../utils/copyUtils';
import { ContentBlockRenderer } from './ContentBlockRenderer';

vi.mock('../../utils/copyUtils', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

// Capture the props MarkdownBlock receives without rendering the real marked
// pipeline. The block-level streaming flag is the value under test here.
const { markdownProps } = vi.hoisted(() => ({
  markdownProps: { isStreaming: undefined as boolean | undefined },
}));

vi.mock('../MarkdownBlock', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => {
    markdownProps.isStreaming = isStreaming;
    return <div data-testid="md">{content}</div>;
  },
}));

vi.mock('../CollapsibleTextBlock', () => ({ default: () => <div /> }));
vi.mock('../toolBlocks', () => ({
  BashToolBlock: () => null,
  EditToolBlock: () => null,
  GenericToolBlock: () => null,
  TaskExecutionBlock: () => null,
}));

const t = ((key: string) => key) as unknown as React.ComponentProps<
  typeof ContentBlockRenderer
>['t'];

const tableBlock = (): ClaudeContentBlock =>
  ({ type: 'text', text: '| a |\n|---|\n| 1 |' }) as unknown as ClaudeContentBlock;

function renderTextBlock({ isStreaming, isLastBlock }: { isStreaming: boolean; isLastBlock: boolean }) {
  markdownProps.isStreaming = undefined;
  return render(
    <ContentBlockRenderer
      block={tableBlock()}
      messageIndex={0}
      messageType="assistant"
      isStreaming={isStreaming}
      isThinkingExpanded={false}
      isThinking={false}
      isLastMessage={false}
      isLastBlock={isLastBlock}
      t={t}
      onToggleThinking={() => {}}
      findToolResult={() => null}
    />,
  );
}

describe('ContentBlockRenderer block-level streaming', () => {
  it('keeps the last block streaming while the message is still streaming', () => {
    renderTextBlock({ isStreaming: true, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(true);
  });

  it('drops an earlier text block out of streaming once a later block arrives', () => {
    // A tool call (or any later block) arriving makes this text block non-last.
    // It must leave the lightweight streaming renderer for the full marked
    // pipeline, otherwise tables/lists stay hidden until the whole turn ends.
    renderTextBlock({ isStreaming: true, isLastBlock: false });
    expect(markdownProps.isStreaming).toBe(false);
  });

  it('renders with the full pipeline once the message has stopped streaming', () => {
    renderTextBlock({ isStreaming: false, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(false);
  });
});

describe('ContentBlockRenderer compaction divider', () => {
  const compactBlock = (overrides: Record<string, unknown> = {}): ClaudeContentBlock => ({
    type: 'compact_summary',
    title: 'chat.compactSummary.compacted',
    content: '## Objective\nship it',
    compactStatus: 'success',
    metadata: { trigger: 'manual', postTokens: 14582, durationMs: 109542 },
    ...overrides,
  }) as unknown as ClaudeContentBlock;

  const renderBlock = (block: ClaudeContentBlock) => render(
    <ContentBlockRenderer
      block={block}
      messageIndex={0}
      messageType="notification"
      isStreaming={false}
      isThinkingExpanded={false}
      isThinking={false}
      isLastMessage={false}
      isLastBlock={false}
      t={t}
      onToggleThinking={() => {}}
      findToolResult={() => null}
    />,
  );

  it('renders a divider with title and stats but no trigger label', () => {
    const { container, getByText, queryByText } = renderBlock(compactBlock());

    expect(getByText('chat.compactSummary.compacted')).toBeTruthy();
    expect(queryByText('chat.compactSummary.triggerManual')).toBeNull();
    expect(getByText('chat.compactSummary.tokensAfter')).toBeTruthy();
    expect(getByText('chat.compactSummary.duration')).toBeTruthy();
    expect(container.querySelector('.compact-divider')).toBeTruthy();
    expect(container.querySelector('.compact-divider__badge')).toBeNull();
    // The raw trigger word must never leak into the UI.
    expect(container.textContent).not.toContain('manual');
    expect(container.querySelector('.compact-divider__panel')).toBeNull();
  });

  it('marks engine-triggered compactions with the auto icon only', () => {
    const { container, queryByText } = renderBlock(compactBlock({
      metadata: { trigger: 'auto', postTokens: 12100, durationMs: 48000 },
    }));

    expect(container.querySelector('.compact-divider__chip--auto')).toBeTruthy();
    expect(queryByText('chat.compactSummary.triggerAuto')).toBeNull();
    expect(container.textContent).not.toContain('auto');
  });

  it('shows the before → after delta when the record carries preTokens', () => {
    const { getByText } = renderBlock(compactBlock({
      metadata: { trigger: 'manual', preTokens: 42800, postTokens: 14600, durationMs: 110000 },
    }));

    expect(getByText('chat.compactSummary.tokensBeforeAfter')).toBeTruthy();
    expect(getByText('chat.compactSummary.freedPercent')).toBeTruthy();
  });

  it('expands the summary panel and copies the summary text', async () => {
    const { container, getByRole, getByText } = renderBlock(compactBlock());

    fireEvent.click(getByRole('button', { name: /chat\.compactSummary\.compacted/ }));

    expect(container.querySelector('.compact-divider__panel')).toBeTruthy();
    expect(getByText('chat.compactSummary.summary')).toBeTruthy();

    fireEvent.click(getByText('chat.compactSummary.copy').closest('button')!);

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('## Objective\nship it'));
    expect(getByText('chat.compactSummary.copied')).toBeTruthy();
  });

  it('shows a failed compaction as a quiet row with the full reason', () => {
    const { container, getByText, queryByText } = renderBlock(compactBlock({
      compactStatus: 'failure',
      title: 'chat.compactFailed',
      content: 'Nothing to compact yet',
    }));

    expect(getByText('chat.compactFailed')).toBeTruthy();
    expect(getByText('Nothing to compact yet')).toBeTruthy();
    expect(container.querySelector('.compact-divider__chip--fail')).toBeTruthy();
    expect(queryByText('chat.compactSummary.duration')).toBeNull();
  });

  it('shows the running state with a spinner and elapsed time', () => {
    const { container, getByText } = renderBlock(compactBlock({
      compactStatus: 'in_progress',
      content: '',
      metadata: { trigger: 'auto' },
      startTime: Date.now(),
    }));

    expect(getByText('chat.autoCompacting')).toBeTruthy();
    expect(container.querySelector('.compact-divider__spinner')).toBeTruthy();
    expect(container.querySelector('.compact-divider__time')).toBeTruthy();
  });
});

describe('ContentBlockRenderer askuserquestion', () => {
  const askBlock = (): ClaudeContentBlock =>
    ({
      type: 'tool_use',
      name: 'askuserquestion',
      id: 'tool-1',
      input: {
        questions: [
          { question: 'Pick a color?', header: 'Choice', options: [{ label: 'Red' }, { label: 'Blue' }] },
        ],
      },
    }) as unknown as ClaudeContentBlock;

  const answerResult = (): ToolResultBlock =>
    ({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'User has answered your questions: "Pick a color?"="Red". You can now continue with the user\'s answers in mind.',
    }) as ToolResultBlock;

  it('renders a read-only Q&A summary instead of returning null', () => {
    const { getByText } = render(
      <ContentBlockRenderer
        block={askBlock()}
        messageIndex={0}
        messageType="assistant"
        isStreaming={false}
        isThinkingExpanded={false}
        isThinking={false}
        isLastMessage={false}
        isLastBlock={false}
        t={t}
        onToggleThinking={() => {}}
        findToolResult={() => answerResult()}
      />,
    );

    expect(getByText('Pick a color?')).toBeTruthy();
    expect(getByText('Red')).toBeTruthy();
  });

  it('renders the question even before a tool_result has arrived', () => {
    const { getByText, queryByText } = render(
      <ContentBlockRenderer
        block={askBlock()}
        messageIndex={0}
        messageType="assistant"
        isStreaming={true}
        isThinkingExpanded={false}
        isThinking={false}
        isLastMessage={true}
        isLastBlock={true}
        t={t}
        onToggleThinking={() => {}}
        findToolResult={() => null}
      />,
    );

    expect(getByText('Pick a color?')).toBeTruthy();
    expect(queryByText('Red')).toBeFalsy();
  });

  it('keeps permission requests suppressed', () => {
    const block = ({
      type: 'tool_use',
      name: 'requestpermissions',
      id: 'tool-2',
      input: {},
    }) as unknown as ClaudeContentBlock;

    const { container } = render(
      <ContentBlockRenderer
        block={block}
        messageIndex={0}
        messageType="assistant"
        isStreaming={false}
        isThinkingExpanded={false}
        isThinking={false}
        isLastMessage={false}
        isLastBlock={false}
        t={t}
        onToggleThinking={() => {}}
        findToolResult={() => null}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});
