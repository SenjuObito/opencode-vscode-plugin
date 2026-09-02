/**
 * questionAnswerStore — Global store for Q&A data emitted by the host.
 *
 * When the user answers an askuserquestion, the host sends the complete
 * Q&A data (questions + answers) via onQuestionAnswered. This store
 * holds that data keyed by callId (the tool_use block's id), so the
 * webview can render the summary card without ID matching.
 */

export interface QuestionAnswerEntry {
  callId: string;
  requestId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  answers: Record<string, string | string[]>;
}

const store = new Map<string, QuestionAnswerEntry>();

// ── React 订阅机制 ──────────────────────────────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot(): number {
  return version;
}

function notify(): void {
  version++;
  for (const listener of listeners) {
    listener();
  }
}

// ── 公共 API ─────────────────────────────────────────────────────────────

export function setQuestionAnswer(entry: QuestionAnswerEntry): void {
  console.log(`[QuestionAnswerStore] setQuestionAnswer callId="${entry.callId}" requestId="${entry.requestId}" questions=${entry.questions.length} answers=`, entry.answers);
  store.set(entry.callId, entry);
  notify();
}

export function getQuestionAnswer(callId: string): QuestionAnswerEntry | undefined {
  const entry = store.get(callId);
  console.log(`[QuestionAnswerStore] getQuestionAnswer callId="${callId}" found=${!!entry}`);
  return entry;
}
