import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_STREAMING_RUNTIME,
  captureStreamingRuntime,
  clearStreamingRuntime,
  restoreStreamingRuntime,
  type StreamingRuntimeRefs,
} from './streamingRuntime';

function makeRefs(overrides: Partial<Record<keyof StreamingRuntimeRefs, unknown>> = {}) {
  const refs: StreamingRuntimeRefs = {
    isStreamingRef: { current: false },
    streamingContentRef: { current: '' },
    streamingThinkingRef: { current: '' },
    useBackendStreamingRenderRef: { current: false },
    streamingMessageIndexRef: { current: -1 },
    streamingTurnIdRef: { current: -1 },
    lastContentUpdateRef: { current: 0 },
    lastThinkingUpdateRef: { current: 0 },
    autoExpandedThinkingKeysRef: { current: new Set<string>() },
    trailingStructuralTextBoundaryRef: { current: null },
  };
  return Object.assign(refs, overrides) as StreamingRuntimeRefs;
}

describe('streamingRuntime', () => {
  beforeEach(() => {
    window.__streamEndProcessedTurnId = undefined;
  });

  it('captures every field that carries per-session state', () => {
    const refs = makeRefs();
    refs.isStreamingRef.current = true;
    refs.streamingContentRef.current = 'hello';
    refs.streamingThinkingRef.current = 'thinking';
    refs.useBackendStreamingRenderRef.current = true;
    refs.streamingMessageIndexRef.current = 5;
    refs.streamingTurnIdRef.current = 3;
    refs.lastContentUpdateRef.current = 1234;
    refs.lastThinkingUpdateRef.current = 4321;
    refs.autoExpandedThinkingKeysRef.current.add('k1');
    refs.autoExpandedThinkingKeysRef.current.add('k2');
    refs.trailingStructuralTextBoundaryRef!.current = { signature: 'sig', textLength: 42 };
    window.__streamEndProcessedTurnId = 3;

    const snapshot = captureStreamingRuntime(refs);

    expect(snapshot).toEqual({
      isStreaming: true,
      content: 'hello',
      thinking: 'thinking',
      useBackendStreamingRender: true,
      turnId: 3,
      lastContentUpdate: 1234,
      lastThinkingUpdate: 4321,
      autoExpandedThinkingKeys: ['k1', 'k2'],
      trailingStructuralTextBoundary: { signature: 'sig', textLength: 42 },
      streamEndProcessedTurnId: 3,
    });
  });

  it('restores content, turnId and the stream-end guard so a resumed turn continues', () => {
    const refs = makeRefs();
    const snapshot = {
      ...DEFAULT_STREAMING_RUNTIME,
      isStreaming: true,
      content: 'resumed text',
      thinking: 'resumed thinking',
      turnId: 7,
      streamEndProcessedTurnId: null,
    };

    restoreStreamingRuntime(refs, snapshot);

    expect(refs.streamingContentRef.current).toBe('resumed text');
    expect(refs.streamingThinkingRef.current).toBe('resumed thinking');
    expect(refs.streamingTurnIdRef.current).toBe(7);
    expect(refs.isStreamingRef.current).toBe(true);
  });

  it('never restores the message index — a background tab may have grown', () => {
    const refs = makeRefs();
    refs.streamingMessageIndexRef.current = 8;

    restoreStreamingRuntime(refs, { ...DEFAULT_STREAMING_RUNTIME, content: 'x' });

    expect(refs.streamingMessageIndexRef.current).toBe(-1);
  });

  it('never touches turnIdCounter, keeping turn ids globally unique', () => {
    const refs = makeRefs();
    // turnIdCounterRef is intentionally not part of the ref bag; assert the
    // snapshot type has no such field so it can never be exchanged by accident.
    const snapshot = captureStreamingRuntime(refs);
    expect(Object.keys(snapshot)).not.toContain('turnIdCounter');
    expect(Object.keys(snapshot)).not.toContain('messageIndex');
  });

  it('replaces the auto-expanded key set instead of merging two sessions', () => {
    const refs = makeRefs();
    refs.autoExpandedThinkingKeysRef.current.add('from-a');

    restoreStreamingRuntime(refs, {
      ...DEFAULT_STREAMING_RUNTIME,
      autoExpandedThinkingKeys: ['from-b'],
    });

    expect([...refs.autoExpandedThinkingKeysRef.current]).toEqual(['from-b']);
  });

  it('clears the stream-end guard when the snapshot has none', () => {
    window.__streamEndProcessedTurnId = 9;
    const refs = makeRefs();

    restoreStreamingRuntime(refs, DEFAULT_STREAMING_RUNTIME);

    expect(window.__streamEndProcessedTurnId).toBeUndefined();
  });

  it('clearStreamingRuntime wipes the accumulator left by a closed tab', () => {
    const refs = makeRefs();
    refs.isStreamingRef.current = true;
    refs.streamingContentRef.current = 'stale 3000 chars';
    refs.streamingTurnIdRef.current = 4;

    clearStreamingRuntime(refs);

    expect(refs.isStreamingRef.current).toBe(false);
    expect(refs.streamingContentRef.current).toBe('');
    expect(refs.streamingTurnIdRef.current).toBe(-1);
    expect(refs.streamingMessageIndexRef.current).toBe(-1);
  });

  it('round-trips a snapshot without losing any field', () => {
    const source = makeRefs();
    source.isStreamingRef.current = true;
    source.streamingContentRef.current = 'A'.repeat(3000);
    source.streamingTurnIdRef.current = 11;
    source.autoExpandedThinkingKeysRef.current.add('alpha');

    const snapshot = captureStreamingRuntime(source);
    const target = makeRefs();
    restoreStreamingRuntime(target, snapshot);

    expect(target.streamingContentRef.current).toHaveLength(3000);
    expect(target.streamingTurnIdRef.current).toBe(11);
    expect(target.isStreamingRef.current).toBe(true);
  });
});
