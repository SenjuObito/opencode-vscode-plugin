import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  getMinAcceptedSequence,
  advanceMinAcceptedSequence,
  resetMinAcceptedSequence,
  clearSessionSequenceBarrier,
} from '../sequenceBarrier';
import { useWindowCallbacks } from '../../useWindowCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';

const createOptions = (overrides?: Partial<UseWindowCallbacksOptions>): UseWindowCallbacksOptions => ({
  addToast: vi.fn(),
  clearToasts: vi.fn(),
  setMessages: vi.fn(),
  setStatus: vi.fn(),
  setLoading: vi.fn(),
  setLoadingStartTime: vi.fn(),
  setIsThinking: vi.fn(),
  setStreamingActive: vi.fn(),
  setHistoryData: vi.fn(),
  setContextUsage: vi.fn(),
  setContextWindowLimit: vi.fn(),
  setSelectedModel: vi.fn(),
  setAvailableModels: vi.fn(),
  setPermissionMode: vi.fn(),
  setReasoningEffort: vi.fn(),
  setCurrentSessionId: vi.fn(),
  setCustomSessionTitle: vi.fn(),
  setSessionLoading: vi.fn(),
  setRevertBoundaryId: vi.fn(),
  setIsCompacting: vi.fn(),
  setCompactingStartTime: vi.fn(),
  setUsagePercentage: vi.fn(),
  setUsageUsedTokens: vi.fn(),
  setUsageMaxTokens: vi.fn(),
  setTaskEvents: vi.fn(),
  setSseTodos: vi.fn(),
  setSubagentHistories: vi.fn(),
  setFilteredFileChanges: vi.fn(),
  userPausedRef: { current: false },
  isUserAtBottomRef: { current: true },
  messagesContainerRef: { current: null },
  suppressNextStatusToastRef: { current: false },
  streamingContentRef: { current: '' },
  streamingThinkingRef: { current: '' },
  isStreamingRef: { current: false },
  useBackendStreamingRenderRef: { current: false },
  autoExpandedThinkingKeysRef: { current: new Set<string>() },
  streamingMessageIndexRef: { current: -1 },
  streamingTurnIdRef: { current: -1 },
  turnIdCounterRef: { current: 0 },
  lastContentUpdateRef: { current: 0 },
  contentUpdateTimeoutRef: { current: null } as { current: number | null },
  lastThinkingUpdateRef: { current: 0 },
  thinkingUpdateTimeoutRef: { current: null } as { current: number | null },
  currentProviderRef: { current: 'opencode' },
  findLastAssistantIndex: (msgs: ClaudeMessage[]) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'assistant') return i;
    }
    return -1;
  },
  extractRawBlocks: () => [],
  patchAssistantForStreaming: (msg) => msg,
  openPermissionDialog: vi.fn(),
  openAskUserQuestionDialog: vi.fn(),
  openPlanApprovalDialog: vi.fn(),
  forceClosePermissionDialog: vi.fn(),
  forceCloseAskUserQuestionDialog: vi.fn(),
  forceClosePlanApprovalDialog: vi.fn(),
  openContextUsageDialog: vi.fn(),
  updateContextUsageData: vi.fn(),
  closeContextUsageDialog: vi.fn(),
  customSessionTitleRef: { current: null },
  currentSessionIdRef: { current: null },
  updateHistoryTitle: vi.fn(),
  applyHistoryTitleLocal: vi.fn(),
  ...overrides,
});

describe('sequenceBarrier - Per-Session Isolation', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__sessionTransitionToken = null;
    window.__sessionTransitionTargetSessionId = null;
    window.__minAcceptedUpdateSequence = 0;
    delete window.__sessionMinAcceptedUpdateSequence;
  });

  it('isolates sequence counter between distinct sessions', () => {
    // Session A advances to sequence 50
    advanceMinAcceptedSequence('session-A', 50);
    expect(getMinAcceptedSequence('session-A')).toBe(50);
    // Session B is independent, still default 0
    expect(getMinAcceptedSequence('session-B')).toBe(0);

    // Session B advances to 5
    advanceMinAcceptedSequence('session-B', 5);
    expect(getMinAcceptedSequence('session-B')).toBe(5);
    expect(getMinAcceptedSequence('session-A')).toBe(50);
  });

  it('resets barrier for target session without affecting other sessions', () => {
    advanceMinAcceptedSequence('session-A', 100);
    advanceMinAcceptedSequence('session-B', 20);

    // Reset session-B barrier to 1 (e.g. on new Coalescer creation)
    resetMinAcceptedSequence('session-B', 1);

    expect(getMinAcceptedSequence('session-B')).toBe(1);
    expect(getMinAcceptedSequence('session-A')).toBe(100);
  });

  it('clears session sequence barrier on session delete or close', () => {
    advanceMinAcceptedSequence('session-A', 80);
    expect(getMinAcceptedSequence('session-A')).toBe(80);

    clearSessionSequenceBarrier('session-A');
    expect(getMinAcceptedSequence('session-A')).toBe(window.__minAcceptedUpdateSequence ?? 0);
  });
});

describe('useWindowCallbacks - Cross-Session History Loading Regression', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__sessionTransitionToken = null;
    window.__sessionTransitionTargetSessionId = null;
    window.__minAcceptedUpdateSequence = 0;
    delete window.__sessionMinAcceptedUpdateSequence;
    window.sendToJava = vi.fn();
  });

  it('allows freshly loaded history session to render after active conversation pushed sequence to high watermark', () => {
    let currentMessages: ClaudeMessage[] = [];
    const setMessages = vi.fn((updater: React.SetStateAction<ClaudeMessage[]>) => {
      currentMessages = typeof updater === 'function' ? updater(currentMessages) : updater;
    });

    const currentSessionIdRef = { current: 'session-active' as string | null };
    const opts = createOptions({
      setMessages,
      currentSessionIdRef,
    });

    renderHook(() => useWindowCallbacks(opts));

    // 1. In session-active, conversation occurs and sequence reaches 60
    act(() => {
      window.updateMessages!(
        'session-active',
        JSON.stringify([{ type: 'assistant', content: 'Turn 1 in active session' }]),
        60
      );
    });
    expect(currentMessages).toHaveLength(1);
    expect(currentMessages[0].content).toBe('Turn 1 in active session');

    // 2. User navigates to history drawer and opens session-history
    currentSessionIdRef.current = 'session-history';
    window.__sessionTransitionTargetSessionId = 'session-history';
    window.__sessionTransitioning = true;

    // Backend resets stream state and calls clearMessages for session-history with barrier=1
    act(() => {
      window.clearMessages!('session-history', 1);
    });
    expect(currentMessages).toHaveLength(0);

    // Backend loads session-history messages from server and flushes sequence=2
    act(() => {
      window.updateMessages!(
        'session-history',
        JSON.stringify([
          { type: 'user', content: 'Historical question' },
          { type: 'assistant', content: 'Historical answer' },
        ]),
        2
      );
    });

    // 3. VERIFY: History messages MUST NOT be blocked by session-active's sequence 60!
    expect(currentMessages).toHaveLength(2);
    expect(currentMessages[0].content).toBe('Historical question');
    expect(currentMessages[1].content).toBe('Historical answer');

    // Complete history load
    act(() => {
      window.historyLoadComplete!('session-history', 2);
    });
    expect(window.__sessionTransitioning).toBe(false);
  });
});
