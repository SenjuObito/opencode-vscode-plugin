import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchHostEnvelope,
  dispatchHostEnvelopeBatch,
  dispatchHostEvent,
  flushHostDispatcher,
  observeHostEpoch,
  pendingHostEventCount,
  resetHostDispatcher,
} from './hostDispatcher';
import { registerHostEvents, resetHostEvents } from './hostEventRegistry';

describe('hostDispatcher', () => {
  beforeEach(() => {
    resetHostDispatcher();
    resetHostEvents();
  });

  it('queues an event until its handler is registered, then replays it in order', () => {
    dispatchHostEvent('earlyEvent', ['first']);
    dispatchHostEvent('earlyEvent', ['second']);

    const handler = vi.fn();
    registerHostEvents({ earlyEvent: handler });
    flushHostDispatcher();

    expect(handler.mock.calls).toEqual([['first'], ['second']]);
    expect(pendingHostEventCount()).toBe(0);
  });

  it('dispatches immediately to an existing handler', () => {
    const handler = vi.fn();
    registerHostEvents({ earlyEvent: handler });

    dispatchHostEvent('earlyEvent', [42]);

    expect(handler).toHaveBeenCalledWith(42);
    expect(pendingHostEventCount()).toBe(0);
  });

  it('does not resolve nested window callback paths', () => {
    const handler = vi.fn();
    (window as any).__nested = { handler };

    dispatchHostEvent('__nested.handler', ['x']);

    expect(handler).not.toHaveBeenCalled();
    expect(pendingHostEventCount()).toBe(1);
    delete (window as any).__nested;
  });

  it('keeps events without handlers queued and does not throw', () => {
    dispatchHostEvent('stillMissing', ['x']);
    flushHostDispatcher();

    expect(pendingHostEventCount()).toBe(1);
  });

  it('bounds the pre-mount queue under a large event burst', () => {
    for (let i = 0; i < 2_100; i++) {
      dispatchHostEvent('notMountedYet', [i]);
    }

    expect(pendingHostEventCount()).toBeLessThanOrEqual(2_000);
    flushHostDispatcher();
    registerHostEvents({ notMountedYet: vi.fn() });
    flushHostDispatcher();
    expect(pendingHostEventCount()).toBe(0);
  });

  it('applies a typed envelope payload and drops events from an older epoch', () => {
    const handler = vi.fn();
    registerHostEvents({ tabScoped: handler });

    dispatchHostEnvelope({
      v: 2,
      type: 'tabScoped',
      tabId: 'tab-a',
      epoch: 2,
      payload: { args: ['fresh'] },
    });
    dispatchHostEnvelope({
      v: 2,
      type: 'tabScoped',
      tabId: 'tab-a',
      epoch: 1,
      payload: { args: ['stale'] },
    });

    expect(handler.mock.calls).toEqual([['fresh']]);
  });

  it('drops pre-reload events after the host resync primes the epoch', () => {
    const handler = vi.fn();
    registerHostEvents({ tabScoped: handler });

    observeHostEpoch('tab-a', 3);
    dispatchHostEnvelope({
      v: 2,
      type: 'tabScoped',
      tabId: 'tab-a',
      epoch: 2,
      payload: { args: ['old-binding'] },
    });
    dispatchHostEnvelope({
      v: 2,
      type: 'tabScoped',
      tabId: 'tab-a',
      epoch: 3,
      payload: { args: ['new-binding'] },
    });

    expect(handler.mock.calls).toEqual([['new-binding']]);
  });

  it('unwraps a single data field for legacy JSON handlers', () => {
    const handler = vi.fn();
    registerHostEvents({ legacyData: handler });

    dispatchHostEnvelope({
      v: 2,
      type: 'legacyData',
      payload: { data: '{"alive":true,"serveReady":true}' },
    });

    expect(handler).toHaveBeenCalledWith(
      '{"alive":true,"serveReady":true}',
      expect.objectContaining({ type: 'legacyData' }),
    );
  });

  it('keeps a multi-field named payload intact', () => {
    const handler = vi.fn();
    registerHostEvents({ namedFields: handler });

    dispatchHostEnvelope({
      v: 2,
      type: 'namedFields',
      payload: { data: 'payload', tabId: 'tab-a' },
    });

    expect(handler).toHaveBeenCalledWith(
      { data: 'payload', tabId: 'tab-a' },
      expect.objectContaining({ type: 'namedFields' }),
    );
  });

  it('dispatches a batch in order and tolerates malformed entries', () => {
    const handler = vi.fn();
    registerHostEvents({ batchEvent: handler });

    dispatchHostEnvelopeBatch([
      { v: 2, type: 'batchEvent', payload: { args: [1] } },
      { nope: true },
      { v: 2, type: 'batchEvent', payload: [2] },
    ]);

    expect(handler.mock.calls).toEqual([[1], [2]]);
  });
});
