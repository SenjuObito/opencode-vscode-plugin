/**
 * turnEnd.test.ts
 *
 * `onTurnEnd` is the daemon's authoritative, per-session turn terminal. These
 * cases pin down the two properties the old terminal signals lacked:
 *
 * 1. it is addressed to the session named on the wire (not "the active tab");
 * 2. it is idempotent on (sessionId, turnId), so it is safe for it to arrive
 *    alongside — or instead of — `onStreamEnd`.
 *
 * Together those are what stop a tab from spinning forever after the user
 * presses stop, which is exactly the failure the old pipeline could not recover
 * from: its terminal was suppressible and had no retry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

function createHarness() {
  let messages: ClaudeMessage[] = [];

  const setStreamingActive = vi.fn();
  const setLoading = vi.fn();
  const setLoadingStartTime = vi.fn();
  const setIsThinking = vi.fn();

  const options = {
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    isStreamingRef: ref(true),
    useBackendStreamingRenderRef: ref(false),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(1),
    turnIdCounterRef: ref(1),
    lastContentUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref<number | null>(null),
    lastThinkingUpdateRef: ref(0),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    currentProviderRef: ref('claude'),
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking: () => {},
    getOrCreateStreamingAssistantIndex: () => -1,
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
  } as unknown as UseWindowCallbacksOptions;

  registerStreamingCallbacks(options);
  return {
    options,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    getMessages: () => messages,
  };
}

describe('onTurnEnd — session-scoped, idempotent terminal', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    delete window.__sessionTabsStore;
    window.__deniedToolIds = undefined;
  });

  it('clears loading and streaming for the session named on the wire', () => {
    const h = createHarness();

    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 7, reason: 'idle' }));

    expect(h.setStreamingActive).toHaveBeenCalledWith(false);
    expect(h.setLoading).toHaveBeenCalledWith(false);
    expect(h.setLoadingStartTime).toHaveBeenCalledWith(null);
    expect(h.setIsThinking).toHaveBeenCalledWith(false);
  });

  it('is dropped when it carries no session identity', () => {
    const h = createHarness();

    // An empty id must never be read as "whichever tab is on screen".
    window.onTurnEnd!('', JSON.stringify({ turnId: 7 }));

    expect(h.setLoading).not.toHaveBeenCalled();
  });

  it('ignores a repeat of the same (sessionId, turnId)', () => {
    const h = createHarness();

    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 7 }));
    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 7 }));

    expect(h.setLoading).toHaveBeenCalledTimes(1);
  });

  it('accepts a later turn of the same session', () => {
    const h = createHarness();

    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 7 }));
    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 8 }));

    expect(h.setLoading).toHaveBeenCalledTimes(2);
  });

  it('does not confuse two sessions that use the same turnId', () => {
    const h = createHarness();

    window.onTurnEnd!('ses_a', JSON.stringify({ turnId: 7 }));
    window.onTurnEnd!('ses_b', JSON.stringify({ turnId: 7 }));

    expect(h.setLoading).toHaveBeenCalledTimes(2);
  });

  it('routes to a background tab when that session is not the active one', () => {
    const h = createHarness();
    const updateBackgroundTab = vi.fn(() => true);
    window.__sessionTabsStore = {
      isActiveSession: (id: string | null | undefined) => id !== 'ses_bg',
      updateBackgroundTab,
    } as unknown as typeof window.__sessionTabsStore;

    window.onTurnEnd!('ses_bg', JSON.stringify({ turnId: 3 }));

    expect(updateBackgroundTab).toHaveBeenCalledTimes(1);
    // And the active session's own state must be left alone.
    expect(h.setLoading).not.toHaveBeenCalled();
  });

  it('survives a payload that is not JSON — identity is what matters', () => {
    const h = createHarness();

    expect(() => window.onTurnEnd!('ses_a', 'not-json')).not.toThrow();
    expect(h.setLoading).toHaveBeenCalledWith(false);
  });
});
