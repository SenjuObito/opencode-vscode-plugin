import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { useWindowCallbacks } from './useWindowCallbacks.js';
import type { UseWindowCallbacksOptions } from './useWindowCallbacks.js';
import type { ClaudeMessage } from '../types/index.js';

// 复用集成测试骨架：验证 onSessionStateRestored 是否真正更新本地 UI 状态。

describe('onSessionStateRestored', () => {
  const t = ((key: string) => key) as any;

  const createOptions = (overrides?: Partial<UseWindowCallbacksOptions>): UseWindowCallbacksOptions => ({
    t,
    addToast: vi.fn(),
    clearToasts: vi.fn(),
    setMessages: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setHistoryData: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setSubagentHistories: vi.fn(),
    setPermissionMode: vi.fn(),
    setCurrentProvider: vi.fn(),
    setOpenCodePermissionMode: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setSelectedOpenCodeModel: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setPermissionDialogTimeoutSeconds: vi.fn(),
    setSdkStatus: vi.fn(),
    setSdkStatusLoaded: vi.fn(),
    setSdkStatusError: vi.fn(),
    setContextInfo: vi.fn(),
    currentProviderRef: { current: 'opencode' },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
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
    findLastAssistantIndex: (msgs: ClaudeMessage[]) =>
      msgs.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1),
    extractRawBlocks: () => [],
    getOrCreateStreamingAssistantIndex: () => 0,
    patchAssistantForStreaming: (msg: ClaudeMessage) => msg,
    syncActiveProviderModelMapping: vi.fn(),
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

  beforeEach(() => {
    window.sendToJava = vi.fn();
    delete window.__pendingBackendTabState;
    delete window.__pendingUsageUpdate;
  });

  it('applies model / mode / effort locally without echoing bridge events', () => {
    const options = createOptions();
    renderHook(() => useWindowCallbacks(options));

    act(() => {
      window.onSessionStateRestored?.(JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        permissionMode: 'plan',
        reasoningEffort: 'high',
      }));
    });

    expect(options.setSelectedOpenCodeModel).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
    // mode setter 用函数式更新（同值短路），解出 updater 验证结果
    const applyUpdater = (setter: ReturnType<typeof vi.fn>, prev: unknown) => {
      expect(setter).toHaveBeenCalledTimes(1);
      const arg = setter.mock.calls[0][0];
      return typeof arg === 'function' ? arg(prev) : arg;
    };
    expect(applyUpdater(options.setOpenCodePermissionMode as never, 'default')).toBe('plan');
    expect(applyUpdater(options.setPermissionMode as never, 'default')).toBe('plan');
    expect(options.setReasoningEffort).toHaveBeenCalledWith('high');
    // 不回发任何桥事件
    expect(window.sendToJava).not.toHaveBeenCalled();
  });
});
