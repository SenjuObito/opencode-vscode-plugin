// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildModelSelectionPayload,
  buildReasoningEffortPayload,
} from './useModelProviderState';

/**
 * Payload tests.
 *
 * The host resolves a payload without a session id against "the window's current
 * session". In a multi-tab webview that drifts from the tab the user is looking
 * at, so the change lands on the wrong OpencodeSession while the UI reports
 * success — exactly the "I switched the model and nothing changed" symptom.
 *
 * The fix is the command envelope: it names the tab and the session, and the
 * host merges that identity into the payload before the handler runs. The
 * payload therefore carries content only — a second copy of the session id could
 * only ever disagree with the envelope.
 */
describe('buildModelSelectionPayload', () => {
  it('carries only the model and the flags', () => {
    expect(buildModelSelectionPayload('opencode/mimo-v2.6-flash-free'))
      .toEqual({ model: 'opencode/mimo-v2.6-flash-free' });
  });

  it('carries the silent flag used by tab-switch restores', () => {
    expect(buildModelSelectionPayload('opencode/x', { silent: true }))
      .toEqual({ model: 'opencode/x', silent: true });
  });
});

describe('buildReasoningEffortPayload', () => {
  it('carries only the effort', () => {
    expect(buildReasoningEffortPayload('high')).toEqual({ reasoningEffort: 'high' });
  });
});
