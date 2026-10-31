import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../types';
import { useChatComputations } from './useChatComputations';

const t = ((key: string) => (key === 'common.newSession' ? 'New session' : key)) as unknown as TFunction;

function titleFor(messages: ClaudeMessage[], customSessionTitle: string | null): string {
  const { result } = renderHook(() => useChatComputations({
    t,
    messages,
    mergedMessages: messages,
    subagentHistories: {},
    customSessionTitle,
    streamingActive: false,
    currentProvider: 'opencode',
    currentSessionId: 'ses_title',
    currentSessionIdRef: { current: 'ses_title' },
    getContentBlocks: () => [],
    sseTodos: null,
  }));
  return result.current.sessionTitle;
}

describe('useChatComputations sessionTitle', () => {
  it('never derives the title from the first user message', () => {
    const messages = [
      { type: 'user', content: 'please build me something' },
    ] as ClaudeMessage[];

    expect(titleFor(messages, null)).toBe('New session');
  });

  it('uses the title the engine published', () => {
    const messages = [
      { type: 'user', content: 'please build me something' },
    ] as ClaudeMessage[];

    expect(titleFor(messages, 'Greeting')).toBe('Greeting');
  });
});
