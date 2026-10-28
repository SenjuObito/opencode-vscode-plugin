import { describe, it, expect } from 'vitest';
import { isEnginePlaceholderTitle } from './sessionTitle';

describe('isEnginePlaceholderTitle', () => {
  it('recognises the engine placeholders', () => {
    expect(isEnginePlaceholderTitle('New session - 2026-10-27T09:20:28.850Z')).toBe(true);
    expect(isEnginePlaceholderTitle('Child session - 2026-10-27T09:20:28.850Z')).toBe(true);
    expect(isEnginePlaceholderTitle('  New session - 2026-10-27T09:20:28.850Z  ')).toBe(true);
  });

  it('keeps real titles and rejects non-strings', () => {
    expect(isEnginePlaceholderTitle('Greeting')).toBe(false);
    expect(isEnginePlaceholderTitle('会话标题未更新排查')).toBe(false);
    expect(isEnginePlaceholderTitle('')).toBe(false);
    expect(isEnginePlaceholderTitle(null)).toBe(false);
    expect(isEnginePlaceholderTitle(undefined)).toBe(false);
    expect(isEnginePlaceholderTitle('New session - 2026-10-27')).toBe(false);
    expect(isEnginePlaceholderTitle('New Session - 2026-10-27T09:20:28.850Z')).toBe(false);
  });
});
