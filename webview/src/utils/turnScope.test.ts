import { describe, expect, it } from 'vitest';
import { computeStatusScopeMessages, finalizeSubagentsForSettledTurn } from './turnScope';
import type { ClaudeMessage, SubagentInfo } from '../types';

const userMsg = (content: string): ClaudeMessage => ({ type: 'user', content });
const assistantMsg = (): ClaudeMessage => ({ type: 'assistant', content: 'ok' });

describe('computeStatusScopeMessages', () => {
  it('uses the full conversation when not streaming', () => {
    const messages = [userMsg('a'), assistantMsg()];
    expect(computeStatusScopeMessages(false, false, [], messages, false)).toBe(messages);
    expect(computeStatusScopeMessages(false, true, [], messages, true)).toBe(messages);
  });

  it('keeps the full conversation while streaming when async agents are present', () => {
    // The reported symptom: a run_in_background agent started in an earlier turn
    // keeps running after the main turn settles; a later turn (agent report /
    // new user request) starts streaming and narrowing would drop its card.
    const messages = [userMsg('a'), assistantMsg()];
    const latest = [userMsg('b'), assistantMsg()];
    expect(computeStatusScopeMessages(true, true, latest, messages, true)).toBe(messages);
    expect(computeStatusScopeMessages(true, true, [], messages, false)).toBe(messages);
  });

  it('narrows to the latest turn while streaming, no async agents, with tool use', () => {
    const latest = [userMsg('b'), assistantMsg()];
    const messages = [userMsg('a'), assistantMsg(), ...latest];
    expect(computeStatusScopeMessages(true, false, latest, messages, true)).toBe(latest);
  });

  it('widens to the full conversation when the latest turn carries no tool use', () => {
    const messages = [userMsg('a'), assistantMsg()];
    expect(computeStatusScopeMessages(true, false, [assistantMsg()], messages, false)).toBe(messages);
  });

  it('widens when the latest-turn slice is empty', () => {
    const messages = [userMsg('a'), assistantMsg()];
    expect(computeStatusScopeMessages(true, false, [], messages, false)).toBe(messages);
  });
});

const subagent = (overrides: Partial<SubagentInfo>): SubagentInfo => ({
  id: 'tu_1',
  type: 'research',
  description: 'task',
  status: 'running',
  messageIndex: 0,
  ...overrides,
});

describe('finalizeSubagentsForSettledTurn', () => {
  it('does not infer async completion from a settled main turn', () => {
    const result = finalizeSubagentsForSettledTurn([subagent({ isAsync: true })], false);
    expect(result[0].status).toBe('running');
  });

  it('preserves terminal status supplied by task_notification or sidechain history', () => {
    const result = finalizeSubagentsForSettledTurn(
      [
        subagent({ isAsync: true, status: 'completed' }),
        subagent({ isAsync: true, status: 'error' }),
      ],
      false,
    );
    expect(result.map((item) => item.status)).toEqual(['completed', 'error']);
  });

  it('does not mutate sync extraction results', () => {
    const running = subagent({ isAsync: false });
    const completed = subagent({ isAsync: false, status: 'completed' });
    const result = finalizeSubagentsForSettledTurn([running, completed], false);
    expect(result).toEqual([running, completed]);
  });

  it('returns the same states while streaming', () => {
    const result = finalizeSubagentsForSettledTurn(
      [subagent({ isAsync: false }), subagent({ isAsync: true })],
      true,
    );
    expect(result[0].status).toBe('running');
    expect(result[1].status).toBe('running');
  });
});
