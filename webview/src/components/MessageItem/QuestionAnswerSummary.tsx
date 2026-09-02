import { memo, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { ToolResultBlock } from '../../types';
import './QuestionAnswerSummary.css';

export interface QuestionSummaryItem {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

interface QuestionAnswerSummaryProps {
  questions: QuestionSummaryItem[];
  answer: ToolResultBlock | null | undefined;
  t: TFunction;
  /** true=已回答（带 ✓ 与「已回答」徽章）；false=未回答/已跳过（带 ? 与「未回答」徽章）。默认 true 以兼容既有用法。 */
  answered?: boolean;
}

/**
 * Parse the opencode `state.output` string to extract per-question answers.
 *
 * Format: `User has answered your questions: "question1"="answer1", "question2"="answer2". ...`
 * We extract the answer values keyed by question text.
 */
function parseAnswersFromOutput(
  output: string | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!output) return result;

  // Match patterns like: "some question text"="some answer"
  // The question text and answer may contain Chinese/CJK characters, spaces, punctuation.
  const regex = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    result.set(match[1], match[2]);
  }
  return result;
}

/**
 * Normalise the opencode tool_result content (string or text-block array) into plain text.
 */
function toAnswerText(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Read-only summary of an opencode `askuserquestion` round-trip, rendered
 * inline in the conversation flow. Matches the old QuestionCard answered-state
 * design: checkmark icon + title + "已回答" badge, then each question row
 * as `[header] question → answer`.
 */
export const QuestionAnswerSummary = memo(function QuestionAnswerSummary({
  questions,
  answer,
  t,
  answered = true,
}: QuestionAnswerSummaryProps) {
  if (!questions.length) return null;

  const answerText = toAnswerText(answer?.content);

  // Parse the answer text to extract per-question answer values.
  const answerMap = useMemo(() => parseAnswersFromOutput(answerText), [answerText]);

  return (
    <div className="question-answer-summary">
      <div className="qas-header">
        <span className={`codicon ${answered ? 'codicon-check' : 'codicon-question'}`} aria-hidden="true" />
        <span className="qas-header-title">
          {t('askUserQuestion.title', 'OpenCode 有一些问题想问你')}
        </span>
        <span className={`qas-answered-badge ${answered ? '' : 'qas-unanswered-badge'}`}>
          {t(
            answered ? 'askUserQuestion.answeredStatus' : 'askUserQuestion.unansweredStatus',
            answered ? '已回答' : '未回答',
          )}
        </span>
      </div>
      <div className="qas-body">
        {questions.map((q, idx) => {
          const header = q.header && q.header !== 'Other'
            ? q.header
            : t('askUserQuestion.fallbackHeader', '问题');
          const answerValue = answerMap.get(q.question) ?? '';
          return (
            <div key={`${q.question}-${idx}`} className="qas-summary-row">
              <span className="qas-tag">{header}</span>
              <span className="qas-question">{q.question}</span>
              {answerValue && (
                <span className="qas-answer">{answerValue}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default QuestionAnswerSummary;
