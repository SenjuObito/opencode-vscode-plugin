import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendHostCommand, sendInterrupt } from './bridge';
import { clearTabStore, seedTabStore } from '../test/seedTabStore';

describe('bridge v2 command envelope', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    clearTabStore();
  });

  const lastCall = () => {
    const calls = (window.sendToJava as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][0] as string;
  };

  it('carries the identity with the command', () => {
    expect(sendHostCommand('tab-1', 'session.send', { text: 'hi' }, 'ses_a')).toBe(true);

    const call = lastCall();
    expect(call.startsWith('host_command:')).toBe(true);

    const envelope = JSON.parse(call.substring('host_command:'.length));
    expect(envelope.v).toBe(2);
    expect(envelope.type).toBe('session.send');
    expect(envelope.tabId).toBe('tab-1');
    expect(envelope.sessionId).toBe('ses_a');
    expect(envelope.requestId).toBeTruthy();
    expect(envelope.payload).toEqual({ text: 'hi' });
  });

  it('keeps a payload request id separate from the command id', () => {
    // Question/plan replies carry the OpenCode request id in the payload.
    // The envelope's requestId is only the idempotency key and must not
    // replace it.
    expect(sendHostCommand(
      'tab-1',
      'question.reply',
      { requestId: 'call_abc', answers: {} },
      'ses_a',
    )).toBe(true);

    const envelope = JSON.parse(lastCall().substring('host_command:'.length));
    expect(envelope.requestId).not.toBe('call_abc');
    expect(envelope.payload.requestId).toBe('call_abc');
  });

  it('refuses to send a command without a tab', () => {
    expect(sendHostCommand('', 'session.send', { text: 'hi' })).toBe(false);
    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('gives every command its own request id', () => {
    sendHostCommand('tab-1', 'session.send', { text: 'a' });
    sendHostCommand('tab-1', 'session.send', { text: 'b' });

    const calls = (window.sendToJava as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const ids = calls.map((call) => JSON.parse((call[0] as string).substring('host_command:'.length)).requestId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bridge interrupt', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    clearTabStore();
  });

  const payloadRaw = () => {
    const call = (window.sendToJava as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    return call;
  };

  it('names the tab it stops', () => {
    seedTabStore([{ id: 'tab-7', sessionId: 'ses_a' }], 'tab-7');

    expect(sendInterrupt({ sessionId: 'ses_a' })).toBe(true);
    const envelope = JSON.parse(payloadRaw().substring('host_command:'.length));
    expect(envelope.type).toBe('session.interrupt');
    expect(envelope.tabId).toBe('tab-7');
    expect(envelope.sessionId).toBe('ses_a');
  });

  it('stops the tab that owns the session, not the active one', () => {
    seedTabStore([
      { id: 'tab-active', sessionId: 'ses_active' },
      { id: 'tab-background', sessionId: 'ses_background' },
    ], 'tab-active');

    sendInterrupt({ sessionId: 'ses_background' });
    const envelope = JSON.parse(payloadRaw().substring('host_command:'.length));
    expect(envelope.tabId).toBe('tab-background');
  });

  it('prefers an explicit tab id', () => {
    seedTabStore([{ id: 'tab-active', sessionId: 'ses_a' }], 'tab-active');

    sendInterrupt({ tabId: 'tab-explicit', sessionId: 'ses_a' });
    const envelope = JSON.parse(payloadRaw().substring('host_command:'.length));
    expect(envelope.tabId).toBe('tab-explicit');
  });
});
