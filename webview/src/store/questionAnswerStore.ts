/**
 * questionAnswerStore — Global store for Q&A data emitted by the host.
 *
 * When the user answers an askuserquestion, the host sends the complete
 * Q&A data (questions + answers) via onQuestionAnswered. This store
 * holds that data keyed by callId (the tool_use block's id), so the
 * webview can render the summary card without ID matching.
 */

import { cardDebugLog } from '../utils/bridge';

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
  cardDebugLog(`[QuestionAnswerStore] setQuestionAnswer callId="${entry.callId}" requestId="${entry.requestId}" questions=${entry.questions.length} answers=`, entry.answers);
  store.set(entry.callId, entry);
  notify();
}

export function getQuestionAnswer(callId: string): QuestionAnswerEntry | undefined {
  const entry = store.get(callId);
  cardDebugLog(`[QuestionAnswerStore] getQuestionAnswer callId="${callId}" found=${!!entry}`);
  return entry;
}

export function removeQuestionAnswerByRequestId(requestId: string): void {
  cardDebugLog(`[QuestionAnswerStore] removeQuestionAnswerByRequestId requestId="${requestId}"`);
  let changed = false;
  for (const [key, val] of store.entries()) {
    if (val.requestId === requestId) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
}

export function clearQuestionAnswers(): void {
  if (store.size > 0) {
    store.clear();
    notify();
  }
}
