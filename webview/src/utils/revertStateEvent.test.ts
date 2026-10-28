import { describe, expect, it } from 'vitest';
import { parseRevertStateEvent } from './revertStateEvent';

describe('parseRevertStateEvent', () => {
  it('reads the named-event shape [payload, envelope]', () => {
    const update = parseRevertStateEvent([
      { state: { hasRevert: true, messageId: 'msg_1' } },
      { type: 'revert.changed', tabId: 'tab-a', sessionId: 'ses_a' },
    ]);

    expect(update).toEqual({ hasRevert: true, messageId: 'msg_1', sessionId: 'ses_a' });
  });

  it('clears the pointer when the named event carries hasRevert=false', () => {
    const update = parseRevertStateEvent([
      { state: { hasRevert: false, messageId: null } },
      { sessionId: 'ses_a' },
    ]);

    expect(update).toEqual({ hasRevert: false, messageId: null, sessionId: 'ses_a' });
  });

  it('reads a state document sent as one JSON string', () => {
    const update = parseRevertStateEvent([
      '{"hasRevert":true,"messageId":"msg_2"}',
      { sessionId: 'ses_a' },
    ]);

    expect(update).toEqual({ hasRevert: true, messageId: 'msg_2', sessionId: 'ses_a' });
  });

  it('accepts the legacy [sessionId, stateJson] pair', () => {
    const update = parseRevertStateEvent(['ses_a', '{"hasRevert":true,"messageId":"msg_3"}']);

    expect(update).toEqual({ hasRevert: true, messageId: 'msg_3', sessionId: 'ses_a' });
  });

  it('accepts the legacy [sessionId, stateObject] pair', () => {
    const update = parseRevertStateEvent(['ses_a', { hasRevert: true, messageId: 'msg_4' }]);

    expect(update).toEqual({ hasRevert: true, messageId: 'msg_4', sessionId: 'ses_a' });
  });

  it('accepts a single state object and a single JSON string', () => {
    expect(parseRevertStateEvent([{ hasRevert: false, messageId: null }]))
      .toEqual({ hasRevert: false, messageId: null, sessionId: null });
    expect(parseRevertStateEvent(['{"hasRevert":true,"messageId":"msg_5"}']))
      .toEqual({ hasRevert: true, messageId: 'msg_5', sessionId: null });
  });

  it('uses the payload session when the envelope does not name one', () => {
    const update = parseRevertStateEvent([
      { state: { hasRevert: true, messageId: 'msg_6', sessionId: 'ses_b' } },
      { type: 'revert.changed' },
    ]);

    expect(update?.sessionId).toBe('ses_b');
  });

  it('returns null for a shape it cannot read', () => {
    expect(parseRevertStateEvent([])).toBeNull();
    expect(parseRevertStateEvent([null, { sessionId: 'ses_a' }])).toBeNull();
    expect(parseRevertStateEvent(['not json'])).toBeNull();
  });
});
