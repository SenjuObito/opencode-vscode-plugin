import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, TodoItem } from '../types';
import { useChatComputations } from './useChatComputations';

const t = ((key: string) => key) as unknown as TFunction;

interface TestMessage extends ClaudeMessage {
  __blocks?: ClaudeContentBlock[];
}

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
  (message as TestMessage).__blocks ?? [];

function todosFor(messages: ClaudeMessage[], sseTodos: TodoItem[] | null): TodoItem[] {
  const { result } = renderHook(() => useChatComputations({
    t,
    messages,
    mergedMessages: messages,
    subagentHistories: {},
    customSessionTitle: null,
    streamingActive: false,
    currentProvider: 'opencode',
    currentSessionId: 'ses_todos',
    currentSessionIdRef: { current: 'ses_todos' },
    getContentBlocks,
    sseTodos,
  }));
  return result.current.globalTodos;
}

const transcriptWithTodoWrite = (): ClaudeMessage[] => [{
  type: 'assistant',
  __blocks: [{
    type: 'tool_use',
    id: 'todo-1',
    name: 'todowrite',
    input: { todos: [{ content: '回放任务', status: 'in_progress' }] },
  }],
} as TestMessage];

/**
 * The canonical list core publishes is the panel's only status source.
 *
 * <p>These cases pin the two ways the view used to disagree with it: it only
 * adopted a non-empty list (so an engine "cleared" state was ignored), and it
 * rewrote `in_progress` as `completed` whenever a turn was not streaming.</p>
 */
describe('useChatComputations globalTodos', () => {
  it('adopts the canonical list verbatim, including in_progress', () => {
    const canonical: TodoItem[] = [
      { id: '1', content: '第一步', status: 'completed' },
      { id: '2', content: '第二步', status: 'in_progress' },
      { id: '3', content: '第三步', status: 'pending' },
    ];

    expect(todosFor([], canonical)).toEqual(canonical);
  });

  it('treats an empty canonical list as "cleared", not as "no data"', () => {
    expect(todosFor(transcriptWithTodoWrite(), [])).toEqual([]);
  });

  it('falls back to the transcript only when there is no canonical list yet', () => {
    expect(todosFor(transcriptWithTodoWrite(), null)).toEqual([
      { content: '回放任务', status: 'in_progress' },
    ]);
  });
});
