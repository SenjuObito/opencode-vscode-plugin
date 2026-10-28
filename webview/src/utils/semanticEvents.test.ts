import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchHostEnvelope, pendingHostEventCount, resetHostDispatcher } from './hostDispatcher';
import { handlerForSemanticType, SEMANTIC_HANDLERS } from './semanticEvents';
import { registerHostEvents, resetHostEvents } from './hostEventRegistry';

describe('semantic event catalog', () => {
  beforeEach(() => {
    resetHostDispatcher();
    resetHostEvents();
  });

  it('maps the catalog onto the webview handlers', () => {
    expect(handlerForSemanticType('content.delta')).toBe('onContentDelta');
    expect(handlerForSemanticType('message.snapshot')).toBe('updateMessages');
    expect(handlerForSemanticType('turn.ended')).toBe('onStreamEnd');
    expect(handlerForSemanticType('permission.requested')).toBe('showPermissionDialog');
    expect(handlerForSemanticType('does.not.exist')).toBeNull();
  });

  it('routes an envelope by its semantic type', () => {
    const handler = vi.fn();
    registerHostEvents({ 'content.delta': handler });

    dispatchHostEnvelope({
      v: 2,
      type: 'content.delta',
      tabId: 'tab-a',
      payload: { args: ['ses_a', 'hello', 'tab-a'] },
    });

    expect(handler).toHaveBeenCalledWith('ses_a', 'hello', 'tab-a');
  });

  it('does not fall back to the legacy function name for types outside the catalog', () => {
    const handler = vi.fn();
    (window as any).legacyHandler = handler;

    dispatchHostEnvelope({
      v: 2,
      type: 'legacyHandler',
      payload: { args: ['x'] },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(pendingHostEventCount()).toBe(1);
    delete (window as any).legacyHandler;
  });

  it('keeps every catalog entry pointing at a handler name', () => {
    for (const [type, handler] of Object.entries(SEMANTIC_HANDLERS)) {
      expect(type).toMatch(/^[a-z][a-z0-9.]*$/);
      expect(handler).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
  });
});
