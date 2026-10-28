import { beforeEach, describe, expect, it } from 'vitest';
import {
  drainPromptsForTab,
  enqueuePrompt,
  pendingPromptCount,
  removeQueuedPrompt,
  resetPendingPromptQueue,
} from './pendingPromptQueue';

describe('pendingPromptQueue', () => {
  beforeEach(() => {
    resetPendingPromptQueue();
  });

  it('按 tab 入队与取走，互不影响', () => {
    enqueuePrompt({ kind: 'permission', tabId: 'tab-a', request: { channelId: 'call_1' } });
    enqueuePrompt({ kind: 'question', tabId: 'tab-a', request: { requestId: 'q_1' } });
    enqueuePrompt({ kind: 'permission', tabId: 'tab-b', request: { channelId: 'call_2' } });

    expect(pendingPromptCount('tab-a')).toBe(2);
    expect(pendingPromptCount('tab-b')).toBe(1);

    const drainedA = drainPromptsForTab('tab-a');
    expect(drainedA.map((p) => p.kind)).toEqual(['permission', 'question']);
    expect(pendingPromptCount('tab-a')).toBe(0);
    expect(pendingPromptCount('tab-b')).toBe(1);
  });

  it('取走后再次取为空（不会重复弹窗）', () => {
    enqueuePrompt({ kind: 'permission', tabId: 'tab-a', request: { channelId: 'call_1' } });
    expect(drainPromptsForTab('tab-a')).toHaveLength(1);
    expect(drainPromptsForTab('tab-a')).toHaveLength(0);
  });

  it('缺 tabId 的请求不入队', () => {
    enqueuePrompt({ kind: 'permission', tabId: '', request: { channelId: 'call_1' } });
    expect(pendingPromptCount('')).toBe(0);
    expect(drainPromptsForTab(null)).toEqual([]);
  });

  it('宿主关闭后从队列摘掉（不能补弹失效卡片）', () => {
    enqueuePrompt({ kind: 'permission', tabId: 'tab-a', request: { channelId: 'call_1' } });
    enqueuePrompt({ kind: 'question', tabId: 'tab-a', request: { requestId: 'q_1' } });

    removeQueuedPrompt('permission', 'call_1');

    const left = drainPromptsForTab('tab-a');
    expect(left.map((p) => p.kind)).toEqual(['question']);
  });
});
