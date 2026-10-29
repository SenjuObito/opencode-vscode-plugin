/**
 * turnEnd.test.ts
 *
 * `turn.settled` 是 daemon 的权威、按会话定址的回合终止。这些用例钉住旧终止
 * 信号缺失的两个性质：
 *
 * 1. 它投给线上点名的那个会话（不是「当前屏上的 tab」）；
 * 2. 它对 (sessionId, turnId) 幂等，所以可以和 `turn.ended` 并存或互相替代。
 *
 * 这两点正是「用户按停止后 tab 一直转圈」无法自愈的原因：旧管线里的终止信号
 * 既可能被抑制，也没有重试。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import { hostEventHandler } from '../../../utils/hostEventRegistry';
import { sessionEvent } from '../../../test/testEvents';
import { getTabStore } from '../../../store/tabStore';
import { seedTabStore } from '../../../test/seedTabStore';

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
    currentProviderRef: ref('opencode'),
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
    seedTabStore([{ id: 'tab-a', sessionId: 'ses_a' }], 'tab-a');
    window.__deniedToolIds = undefined;
  });

  it('clears loading and streaming for the session named on the wire', () => {
    const h = createHarness();

    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 7, reason: 'idle' }) }));

    expect(h.setStreamingActive).toHaveBeenCalledWith(false);
    expect(h.setLoading).toHaveBeenCalledWith(false);
    expect(h.setLoadingStartTime).toHaveBeenCalledWith(null);
    expect(h.setIsThinking).toHaveBeenCalledWith(false);
  });

  it('is dropped when it carries no session identity', () => {
    const h = createHarness();

    // 空 id 绝不能被理解成「当前屏上的那个 tab」。
    hostEventHandler('turn.settled')!(...sessionEvent(null, { value: JSON.stringify({ turnId: 7 }) }));

    expect(h.setLoading).not.toHaveBeenCalled();
  });

  it('ignores a repeat of the same (sessionId, turnId)', () => {
    const h = createHarness();

    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 7 }) }));
    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 7 }) }));

    expect(h.setLoading).toHaveBeenCalledTimes(1);
  });

  it('accepts a later turn of the same session', () => {
    const h = createHarness();

    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 7 }) }));
    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 8 }) }));

    expect(h.setLoading).toHaveBeenCalledTimes(2);
  });

  it('does not confuse two sessions that use the same turnId', () => {
    // 没有 tab 条：两个会话都是前台，唯一能抑制第二次终止的只可能是
    // 缺了 sessionId 的去重键。
    seedTabStore([], '');
    const h = createHarness();

    hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { terminal: JSON.stringify({ turnId: 7 }) }));
    hostEventHandler('turn.settled')!(...sessionEvent('ses_b', { terminal: JSON.stringify({ turnId: 7 }) }));

    expect(h.setLoading).toHaveBeenCalledTimes(2);
  });

  it('routes to a background tab when that session is not the active one', () => {
    const h = createHarness();
    seedTabStore([
      { id: 'tab-a', sessionId: 'ses_a' },
      { id: 'tab-bg', sessionId: 'ses_bg' },
    ], 'tab-a');

    hostEventHandler('turn.settled')!(...sessionEvent('ses_bg', { terminal: JSON.stringify({ turnId: 3 }) }, 'tab-bg'));

    expect(getTabStore().findById('tab-bg')?.streamingActive).toBe(false);
    expect(getTabStore().findById('tab-bg')?.loading).toBe(false);
    // 活跃会话自己的状态必须不动。
    expect(h.setLoading).not.toHaveBeenCalled();
  });

  it('survives a payload that is not JSON — identity is what matters', () => {
    const h = createHarness();

    expect(() => hostEventHandler('turn.settled')!(...sessionEvent('ses_a', { value: 'not-json' }))).not.toThrow();
    expect(h.setLoading).toHaveBeenCalledWith(false);
  });
});
