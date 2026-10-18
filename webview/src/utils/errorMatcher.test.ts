import { describe, expect, it } from 'vitest';
import { matchErrorPattern } from './errorMatcher';

describe('matchErrorPattern', () => {
  it('returns null for empty input', () => {
    expect(matchErrorPattern('')).toBeNull();
  });

  it('matches case-insensitively on the regex portion', () => {
    expect(matchErrorPattern('FREE USAGE EXCEEDED')?.code).toBe('opencodeQuotaExceeded');
    expect(matchErrorPattern('SPAWN EBUSY')?.code).toBe('spawnEbusy');
  });

  it('returns null when no pattern matches the error text', () => {
    expect(matchErrorPattern('Some unrelated error message')).toBeNull();
  });

  it('normalises an explicit presentation field', () => {
    const result = matchErrorPattern('Free usage exceeded, subscribe to Go');
    expect(result?.code).toBe('opencodeQuotaExceeded');
    expect(result?.presentation).toBe('bar');
  });

  it('defaults presentation to "card" when the pattern omits it', () => {
    const result = matchErrorPattern('spawn EBUSY');
    expect(result?.code).toBe('spawnEbusy');
    expect(result?.presentation).toBe('card');
  });

  it('passes through the optional actionLink fallback', () => {
    const result = matchErrorPattern('Free usage exceeded, subscribe to Go');
    expect(result?.actionLink).toBe('https://opencode.ai/go');
  });

  it('leaves actionLink undefined when the pattern has none', () => {
    expect(matchErrorPattern('spawn EBUSY')?.actionLink).toBeUndefined();
  });

  it('matches spawn EBUSY anywhere in the text', () => {
    expect(matchErrorPattern('something failed: spawn ebusy at line 42')?.code).toBe('spawnEbusy');
  });
});
