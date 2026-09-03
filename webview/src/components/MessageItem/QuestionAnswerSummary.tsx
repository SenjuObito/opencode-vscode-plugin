import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ToolResultBlock } from '../../types';
import './QuestionAnswerSummary.css';

export interface QuestionSummaryItem {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/**
 * Lifecycle state of an `askuserquestion` round-trip, surfaced by the inline
 * read-only summary card.
 *
 * - `answered`     — user submitted a real answer (matched `"q"="a"` pairs).
 * - `cancelled`    — user explicitly skipped the question (or opencode's
 *                    daemon rejected it as an error: `state.error` and the
 *                    bridge `is_error=true` flag). We can't yet distinguish
 *                    "user pressed skip" from "system timed out" — opencode's
 *                    daemon uses the same `failTool(..., "question rejected")`
 *                    path for both. Treat every `is_error=true` as cancelled.
 * - `unanswered`   — neither answered nor cancelled (defensive fallback; in
 *                    practice the daemon either answers or fails the tool).
 */
export type QuestionSummaryStatus = 'answered' | 'cancelled' | 'unanswered';

interface QuestionAnswerSummaryProps {
  questions: QuestionSummaryItem[];
  answer: ToolResultBlock | null | undefined;
  t: TFunction;
  /** Card lifecycle status. Defaults to `'answered'` for backward compat. */
  status?: QuestionSummaryStatus;
  /**
   * Structured answers keyed by question text. Supplied when the host has the
   * full `onQuestionAnswered` payload (the storedQA path); wins over the
   * string-parsing fallback so we never lose data to a serializer mismatch.
   */
  answers?: Map<string, string>;
}

/**
 * Parse the opencode `state.output` string to extract per-question answers.
 *
 * Supports two wire formats:
 *
 * 1. **Protocol format** (opencode daemon  → webview):
 *    `User has answered your questions: "question1"="answer1", "question2"="answer2".`
 *
 * 2. **Round-trip fallback** (host-side, when only `state.output` is available
 *    as plain text without the `=` pairs): the opencode answer block content
 *    may also be serialised as `question\nanswer\n\nquestion\nanswer`
 *    (see ContentBlockRenderer's storedQA path). We split on blank lines and
 *    the first newline inside each block.
 *
 * If `answers` is supplied (the structured Map from questionAnswerStore),
 * it always wins — no parsing needed.
 */
function parseAnswersFromOutput(
  output: string | undefined,
  answers?: Map<string, string>,
): Map<string, string> {
  if (answers && answers.size > 0) return answers;
  const result = new Map<string, string>();
  if (!output) return result;

  // (1) Protocol format: "question"="answer"
  const protocolRe = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = protocolRe.exec(output)) !== null) {
    result.set(m[1], m[2]);
  }
  if (result.size > 0) return result;

  // (2) Round-trip fallback: "question\nanswer" with blank-line separator.
  for (const pair of output.split(/\n\n+/)) {
    const newlineIdx = pair.indexOf('\n');
    if (newlineIdx <= 0) continue;
    const q = pair.slice(0, newlineIdx).trim();
    const a = pair.slice(newlineIdx + 1).trim();
    if (q && a) result.set(q, a);
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

const STATUS_ICON: Record<QuestionSummaryStatus, string> = {
  answered: 'codicon-check',
  cancelled: 'codicon-circle-slash',
  unanswered: 'codicon-question',
};

const STATUS_BADGE_CLASS: Record<QuestionSummaryStatus, string> = {
  // `answered` keeps the base `.qas-answered-badge` (green) styling.
  answered: '',
  cancelled: 'qas-cancelled-badge',
  unanswered: 'qas-unanswered-badge',
};

const STATUS_I18N_KEY: Record<QuestionSummaryStatus, string> = {
  answered: 'askUserQuestion.answeredStatus',
  cancelled: 'askUserQuestion.cancelledStatus',
  unanswered: 'askUserQuestion.unansweredStatus',
};

const STATUS_FALLBACK: Record<QuestionSummaryStatus, string> = {
  answered: '已回答',
  cancelled: '已取消',
  unanswered: '未回答',
};

/**
 * Read-only summary of an opencode `askuserquestion` round-trip, rendered
 * inline in the conversation flow.
 *
 * The status badge maps to the lifecycle outcome:
 *   ✓  answered    — green "已回答"
 *   ⊘  cancelled   — neutral "已取消"  (user skip OR daemon-side reject)
 *   ?  unanswered  — neutral "未回答"  (defensive fallback)
 */
export const QuestionAnswerSummary = memo(function QuestionAnswerSummary({
  questions,
  answer,
  t,
  status = 'answered',
  answers,
}: QuestionAnswerSummaryProps) {
  if (!questions.length) return null;

  const answerText = toAnswerText(answer?.content);

  // Prefer the structured `answers` map (storedQA path); fall back to parsing
  // the opencode wire-format string from `answer.content`. Both formats are
  // supported — see parseAnswersFromOutput.
  const answerMap = parseAnswersFromOutput(answerText, answers);

  const iconClass = STATUS_ICON[status];
  const badgeClass = STATUS_BADGE_CLASS[status];
  const i18nKey = STATUS_I18N_KEY[status];
  const fallback = STATUS_FALLBACK[status];

  return (
    <div className="question-answer-summary">
      <div className="qas-header">
        <span className={`codicon ${iconClass}`} aria-hidden="true" />
        <span className="qas-header-title">
          {t('askUserQuestion.title', 'OpenCode 有一些问题想问你')}
        </span>
        <span className={`qas-answered-badge ${badgeClass}`.trim()}>
          {t(i18nKey, fallback)}
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