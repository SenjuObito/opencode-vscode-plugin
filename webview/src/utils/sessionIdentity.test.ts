/**
 * sessionIdentity.test.ts
 *
 * The rule under test: an empty session id is "unattributable", never "the
 * session currently on screen". Every one of these cases used to be silently
 * rewritten into the active session, which is what made concurrently streaming
 * sessions swap content.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveSessionId, droppedCount, resetDroppedCounts } from './sessionIdentity';

describe('resolveSessionId', () => {
  beforeEach(() => {
    resetDroppedCounts();
  });

  it('returns a real session id unchanged', () => {
    expect(resolveSessionId('ses_abc', 'kind')).toBe('ses_abc');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveSessionId('  ses_abc  ', 'kind')).toBe('ses_abc');
  });

  it('rejects an empty string', () => {
    expect(resolveSessionId('', 'contentDelta')).toBeNull();
    expect(droppedCount('contentDelta')).toBe(1);
  });

  it('rejects the string forms the host produces for a null argument', () => {
    // WebviewEventQueue#sanitizeArgForJsLiteral turns null into ''.
    expect(resolveSessionId(null, 'onStreamEnd')).toBeNull();
    expect(resolveSessionId(undefined, 'onStreamEnd')).toBeNull();
    expect(resolveSessionId('null', 'onStreamEnd')).toBeNull();
    expect(resolveSessionId('undefined', 'onStreamEnd')).toBeNull();
    expect(droppedCount('onStreamEnd')).toBe(4);
  });

  it('counts drops per kind so a regression is visible instead of silent', () => {
    resolveSessionId('', 'a');
    resolveSessionId('', 'a');
    resolveSessionId('', 'b');
    expect(droppedCount('a')).toBe(2);
    expect(droppedCount('b')).toBe(1);
    expect(droppedCount('never-seen')).toBe(0);
  });

  it('never falls back to a caller-supplied current session', () => {
    // Regression guard for the removed `targetSessionId || currentSessionIdRef.current`
    // idiom: there is deliberately no second parameter to fall back to.
    expect(resolveSessionId('', 'delta')).toBeNull();
  });
});
