import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { QuestionAnswerSummary } from './QuestionAnswerSummary';
import { ContentBlockRenderer } from './ContentBlockRenderer';

// t returns the i18next fallback when provided, else the key. This mirrors a
// missing-translation situation and lets us assert the real Chinese fallbacks
// ("已回答" / "未回答") used by the answered-status badge.
const t = ((_key: string, fallback?: string) => fallback ?? _key) as unknown as TFunction;

vi.mock('../MarkdownBlock', () => ({
  default: () => <div />,
}));
vi.mock('../CollapsibleTextBlock', () => ({ default: () => <div /> }));
vi.mock('../toolBlocks', () => ({
  BashToolBlock: () => null,
  EditToolBlock: () => null,
  GenericToolBlock: () => null,
  TaskExecutionBlock: () => null,
}));

const questions = [
  { question: 'Pick a color?', header: 'Choice', options: [{ label: 'Red' }, { label: 'Blue' }] },
];

const answeredResult = (): ToolResultBlock =>
  ({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'User has answered your questions: "Pick a color?"="Red".',
  }) as ToolResultBlock;

const emptyResult = (): ToolResultBlock =>
  ({ type: 'tool_result', tool_use_id: 'tool-1', content: '' }) as ToolResultBlock;

describe('QuestionAnswerSummary answered state', () => {
  it('shows the answered badge (✓ / 已回答) when answered=true', () => {
    const { container, getByText } = render(
      <QuestionAnswerSummary questions={questions} answer={answeredResult()} t={t} answered />,
    );
    expect(container.querySelector('.codicon-check')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(getByText('已回答')).toBeTruthy();
  });

  it('shows the unanswered badge (? / 未回答) when answered=false', () => {
    const { container, getByText } = render(
      <QuestionAnswerSummary questions={questions} answer={null} t={t} answered={false} />,
    );
    expect(container.querySelector('.codicon-question')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeTruthy();
    expect(getByText('未回答')).toBeTruthy();
  });

  it('defaults to answered=true when the prop is omitted', () => {
    const { container } = render(
      <QuestionAnswerSummary questions={questions} answer={null} t={t} />,
    );
    expect(container.querySelector('.codicon-check')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
  });
});

describe('ContentBlockRenderer askuserquestion answered inference', () => {
  const askBlock = (): ClaudeContentBlock =>
    ({
      type: 'tool_use',
      name: 'askuserquestion',
      id: 'tool-1',
      input: { questions },
    }) as unknown as ClaudeContentBlock;

  function renderAsk(findToolResult: () => ToolResultBlock | null) {
    return render(
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
        findToolResult={findToolResult}
      />,
    );
  }

  it('marks the card unanswered when the answer text is empty', () => {
    const { container, getByText } = renderAsk(emptyResult);
    expect(container.querySelector('.qas-unanswered-badge')).toBeTruthy();
    expect(getByText('未回答')).toBeTruthy();
  });

  it('marks the card answered when the answer text is present', () => {
    const { container, getByText } = renderAsk(answeredResult);
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(getByText('已回答')).toBeTruthy();
  });
});
