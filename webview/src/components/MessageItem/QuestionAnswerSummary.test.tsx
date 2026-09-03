import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { QuestionAnswerSummary } from './QuestionAnswerSummary';
import { ContentBlockRenderer } from './ContentBlockRenderer';

// t returns the i18next fallback when provided, else the key. This mirrors a
// missing-translation situation and lets us assert the real Chinese fallbacks
// ("已回答" / "已取消" / "未回答") used by the status badge.
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

const rejectedResult = (): ToolResultBlock =>
  ({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    is_error: true,
    content: 'question rejected',
  }) as ToolResultBlock;

describe('QuestionAnswerSummary status badge', () => {
  it('shows the answered badge (✓ / 已回答) when status=answered', () => {
    const { container, getByText } = render(
      <QuestionAnswerSummary questions={questions} answer={answeredResult()} t={t} status="answered" />,
    );
    expect(container.querySelector('.codicon-check')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.qas-cancelled-badge')).toBeNull();
    expect(getByText('已回答')).toBeTruthy();
  });

  it('shows the cancelled badge (⊘ / 已取消) when status=cancelled', () => {
    const { container, getByText } = render(
      <QuestionAnswerSummary questions={questions} answer={rejectedResult()} t={t} status="cancelled" />,
    );
    expect(container.querySelector('.codicon-circle-slash')).toBeTruthy();
    expect(container.querySelector('.qas-cancelled-badge')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.codicon-check')).toBeNull();
    expect(getByText('已取消')).toBeTruthy();
  });

  it('shows the unanswered badge (? / 未回答) when status=unanswered', () => {
    const { container, getByText } = render(
      <QuestionAnswerSummary questions={questions} answer={null} t={t} status="unanswered" />,
    );
    expect(container.querySelector('.codicon-question')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeTruthy();
    expect(container.querySelector('.qas-cancelled-badge')).toBeNull();
    expect(container.querySelector('.codicon-check')).toBeNull();
    expect(getByText('未回答')).toBeTruthy();
  });

  // Regression: when the question text contains = and is multi-byte (CJK),
  // the round-trip fallback parser must still extract the answer. The
  // storedQA path in ContentBlockRenderer formats content as
  // "question\nanswer\n\nquestion\nanswer", which the old parser ignored.
  it('parses storedQA-style "question\nanswer" content into the answer text', () => {
    const storedQAContent = 'Pick a color?\nRed';
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: storedQAContent,
    } as ToolResultBlock;
    const { container } = render(
      <QuestionAnswerSummary questions={questions} answer={result} t={t} status="answered" />,
    );
    expect(container.querySelector('.qas-answer')?.textContent).toBe('Red');
  });

  it('prefers the structured `answers` prop over parsing answer.content', () => {
    // Suppose the wire content is empty/garbled, but the host has the
    // structured answers map — the card must still show "Red".
    const empty = { type: 'tool_result', tool_use_id: 'tool-1', content: '' } as ToolResultBlock;
    const structured = new Map<string, string>([['Pick a color?', 'Red']]);
    const { container } = render(
      <QuestionAnswerSummary
        questions={questions}
        answer={empty}
        answers={structured}
        t={t}
        status="answered"
      />,
    );
    expect(container.querySelector('.qas-answer')?.textContent).toBe('Red');
  });

  it('defaults to answered=true when the status prop is omitted', () => {
    const { container } = render(
      <QuestionAnswerSummary questions={questions} answer={null} t={t} />,
    );
    expect(container.querySelector('.codicon-check')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.qas-cancelled-badge')).toBeNull();
  });
});

describe('ContentBlockRenderer askuserquestion status inference', () => {
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
    expect(container.querySelector('.qas-cancelled-badge')).toBeNull();
    expect(getByText('未回答')).toBeTruthy();
  });

  it('marks the card answered when the answer text is present', () => {
    const { container, getByText } = renderAsk(answeredResult);
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.qas-cancelled-badge')).toBeNull();
    expect(getByText('已回答')).toBeTruthy();
  });

  // Regression: opencode's rejectQuestion path emits a tool_result with
  // `is_error=true` and content "question rejected" (no `"q"="a"` pairs).
  // Previously this triggered the "已回答" badge because hasAnswer only
  // checked the content length. The card should now render as "已取消".
  it('marks the card cancelled when tool_result is_error=true (user skip)', () => {
    const { container, getByText } = renderAsk(rejectedResult);
    expect(container.querySelector('.qas-cancelled-badge')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.codicon-check')).toBeNull();
    expect(getByText('已取消')).toBeTruthy();
  });

  it('marks the card cancelled even if is_error=true with non-empty but unparseable content', () => {
    const weirdResult = (): ToolResultBlock =>
      ({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        is_error: true,
        // Any non-empty error text — still cancels, doesn't fall back to answered.
        content: 'Some unexpected error happened',
      }) as ToolResultBlock;
    const { container, getByText } = renderAsk(weirdResult);
    expect(container.querySelector('.qas-cancelled-badge')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(getByText('已取消')).toBeTruthy();
  });

  // Regression: some bridge paths / older daemon builds may drop the
  // `is_error` flag and only forward the `"question rejected"` literal in
  // the content. The cancelled badge must still show — fallback on the
  // exact string opencode writes via `failTool(state, ask.ref, "question rejected")`.
  it('marks the card cancelled when content literally is "question rejected" without is_error', () => {
    const literalCancelResult = (): ToolResultBlock =>
      ({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        // intentionally no is_error
        content: 'question rejected',
      }) as ToolResultBlock;
    const { container, getByText } = renderAsk(literalCancelResult);
    expect(container.querySelector('.qas-cancelled-badge')).toBeTruthy();
    expect(container.querySelector('.qas-unanswered-badge')).toBeNull();
    expect(container.querySelector('.codicon-check')).toBeNull();
    expect(getByText('已取消')).toBeTruthy();
  });
});