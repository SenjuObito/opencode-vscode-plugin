import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchHostEnvelope, pendingHostEventCount } from './hostDispatcher';
import {
  hostEventHandler,
  hostEventCount,
  registerHostEvents,
  resetHostEvents,
} from './hostEventRegistry';

describe('host event registry', () => {
  beforeEach(() => {
    resetHostEvents();
  });

  it('routes a semantic event to its registered handler', () => {
    const handler = vi.fn();
    registerHostEvents({ 'content.delta': handler });

    expect(hostEventHandler('content.delta')).toBe(handler);
    expect(hostEventCount()).toBe(1);
  });

  it('is consulted before the window globals', () => {
    const registered = vi.fn();
    const legacy = vi.fn();
    (window as any).onContentDelta = legacy;
    registerHostEvents({ 'content.delta': registered });

    dispatchHostEnvelope({
      v: 2,
      type: 'content.delta',
      payload: { args: ['ses_a', 'hi'] },
    });

    expect(registered).toHaveBeenCalledWith('ses_a', 'hi');
    expect(legacy).not.toHaveBeenCalled();
    delete (window as any).onContentDelta;
  });

  it('skips entries without a handler', () => {
    registerHostEvents({ 'content.delta': undefined });

    expect(hostEventHandler('content.delta')).toBeNull();
    expect(hostEventCount()).toBe(0);
  });

  it('does not fall back to a window function', () => {
    const legacy = vi.fn();
    (window as any).onContentDelta = legacy;

    dispatchHostEnvelope({
      v: 2,
      type: 'content.delta',
      payload: { args: ['ses_a', 'hi'] },
    });

    expect(legacy).not.toHaveBeenCalled();
    expect(pendingHostEventCount()).toBe(1);

    delete (window as any).onContentDelta;
  });
});
