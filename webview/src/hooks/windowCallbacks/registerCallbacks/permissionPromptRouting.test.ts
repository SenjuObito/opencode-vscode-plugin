/**
 * permissionPromptRouting.test.ts
 *
 * 问题弹窗 / 权限弹窗的会话路由。
 *
 * 两个真实故障由这组用例看守：
 *
 * 1. 「弹窗不弹，只看到一张已取消卡片」——后台会话的 prompt 找不到对应 tab，
 *    旧代码在这里直接丢掉，服务端随后按拒绝结算。现在：找不到 tab 也要在前台
 *    弹出（回复按 permission/question id 走注册表，仍能回到正确的会话）。
 * 2. 「弹窗弹到别的会话」——后台会话的 prompt 被塞进当前 tab 的待决列表。
 *    现在：只写真正持有该 sessionId 的那个 tab。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerPermissionCallbacks } from './permissionCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

vi.mock('../../../utils/bridge', () => ({
  cardDebugLog: vi.fn(),
  sendBridgeEvent: vi.fn(),
  sendTypedBridgeEvent: vi.fn(),
}));

interface FakeTab {
  id: string;
  sessionId: string | null;
  messages?: unknown[];
  loading?: boolean;
  streamingActive?: boolean;
  pendingPermissions?: any[];
  pendingQuestions?: any[];
}

/** Faithful stand-in for the real __sessionTabsStore contract. */
function createTabsStore(tabs: FakeTab[], activeTabId: string) {
  return {
    isActiveSession: (sessionId: string | null | undefined): boolean => {
      if (!sessionId) return false;
      const active = tabs.find((t) => t.id === activeTabId);
      if (!active) return false;
      return active.sessionId === sessionId || active.id === sessionId;
    },
    updateBackgroundTab: (
      predicate: (tab: FakeTab) => boolean,
      updater: (tab: FakeTab) => void,
    ): boolean => {
      const idx = tabs.findIndex(predicate);
      if (idx === -1) return false;
      const clone = { ...tabs[idx] };
      updater(clone);
      tabs[idx] = clone;
      return true;
    },
  };
}

function createHarness(tabs: FakeTab[], activeTabId: string) {
  const openPermissionDialog = vi.fn();
  const openAskUserQuestionDialog = vi.fn();
  const openPlanApprovalDialog = vi.fn();
  const forceClosePermissionDialog = vi.fn();
  const forceCloseAskUserQuestionDialog = vi.fn();
  const forceClosePlanApprovalDialog = vi.fn();
  const addToast = vi.fn();

  const options = {
    addToast,
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
  } as unknown as UseWindowCallbacksOptions;

  registerPermissionCallbacks(options);

  return {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    addToast,
  };
}

const permissionJson = (channelId: string, sessionId: string | null) =>
  JSON.stringify({
    channelId,
    toolName: 'Bash',
    sessionId: sessionId ?? undefined,
    inputs: { command: 'ls' },
  });

const questionJson = (requestId: string, sessionId: string | null) =>
  JSON.stringify({
    requestId,
    toolName: 'ask',
    sessionId: sessionId ?? undefined,
    questions: [{ question: 'pick one', options: ['a', 'b'] }],
  });

describe('showPermissionDialog — session routing', () => {
  beforeEach(() => {
    delete window.__sessionTabsStore;
    delete window.__pendingPermissionDialogRequests;
    delete window.__pendingAskUserQuestionDialogRequests;
    delete window.__pendingPlanApprovalDialogRequests;
    delete window.__pendingToasts;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    vi.restoreAllMocks();
  });

  it('stores a background session prompt on THAT tab, not the active one', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-a', sessionId: 'ses_a', pendingPermissions: [] },
      { id: 'tab-b', sessionId: 'ses_b', pendingPermissions: [] },
    ];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showPermissionDialog!(permissionJson('per_b1', 'ses_b'));

    expect(h.openPermissionDialog).not.toHaveBeenCalled();
    expect(tabs[1].pendingPermissions).toHaveLength(1);
    expect(tabs[1].pendingPermissions![0].channelId).toBe('per_b1');
    // 前台 tab 一个都不许收到
    expect(tabs[0].pendingPermissions).toHaveLength(0);
  });

  it('de-duplicates a repeated channelId on the same background tab', () => {
    const tabs: FakeTab[] = [{ id: 'tab-b', sessionId: 'ses_b', pendingPermissions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showPermissionDialog!(permissionJson('per_b1', 'ses_b'));
    window.showPermissionDialog!(permissionJson('per_b1', 'ses_b'));

    expect(h.openPermissionDialog).not.toHaveBeenCalled();
    expect(tabs[0].pendingPermissions).toHaveLength(1);
  });

  it('opens the dialog immediately when the prompt belongs to the active session', () => {
    const tabs: FakeTab[] = [{ id: 'tab-a', sessionId: 'ses_a', pendingPermissions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showPermissionDialog!(permissionJson('per_a1', 'ses_a'));

    expect(h.openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(h.openPermissionDialog.mock.calls[0][0].channelId).toBe('per_a1');
    expect(tabs[0].pendingPermissions).toHaveLength(0);
  });

  it('shows the prompt in the active window when NO tab claims the session (never drops it)', () => {
    // 回归：「已取消」卡片却没有对话框 —— 旧代码在这里 return，服务端随后按拒绝结算。
    const tabs: FakeTab[] = [{ id: 'tab-a', sessionId: 'ses_a', pendingPermissions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showPermissionDialog!(permissionJson('per_x', 'ses_unbound'));

    expect(h.openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(h.openPermissionDialog.mock.calls[0][0].sessionId).toBe('ses_unbound');
  });

  it('still opens the dialog when the prompt carries no session identity', () => {
    const tabs: FakeTab[] = [{ id: 'tab-a', sessionId: 'ses_a', pendingPermissions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    expect(() => window.showPermissionDialog!(permissionJson('per_anon', null))).not.toThrow();
    expect(h.openPermissionDialog).toHaveBeenCalledTimes(1);
  });

  it('survives a malformed payload without throwing', () => {
    const h = createHarness([], 'tab-a');
    expect(() => window.showPermissionDialog!('not-json')).not.toThrow();
    expect(h.openPermissionDialog).not.toHaveBeenCalled();
  });

  it('forceClosePermissionDialog removes the request from the background tab', () => {
    const tabs: FakeTab[] = [{ id: 'tab-b', sessionId: 'ses_b', pendingPermissions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showPermissionDialog!(permissionJson('per_b1', 'ses_b'));
    expect(tabs[0].pendingPermissions).toHaveLength(1);

    window.forceClosePermissionDialog!('per_b1');

    expect(h.forceClosePermissionDialog).toHaveBeenCalledWith('per_b1');
    expect(tabs[0].pendingPermissions).toHaveLength(0);
  });

  it('drains prompts queued before React mounted', () => {
    window.__pendingPermissionDialogRequests = [permissionJson('per_pre', 'ses_a')];
    const h = createHarness([], 'tab-a');

    expect(window.__pendingPermissionDialogRequests).toHaveLength(0);
    expect(h.openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(h.openPermissionDialog.mock.calls[0][0].channelId).toBe('per_pre');
  });
});

describe('showAskUserQuestionDialog — session routing', () => {
  beforeEach(() => {
    delete window.__sessionTabsStore;
    delete window.__pendingPermissionDialogRequests;
    delete window.__pendingAskUserQuestionDialogRequests;
    delete window.__pendingPlanApprovalDialogRequests;
    delete window.__pendingToasts;
  });

  afterEach(() => {
    delete window.__sessionTabsStore;
    vi.restoreAllMocks();
  });

  it('stores a background session question on THAT tab, not the active one', () => {
    const tabs: FakeTab[] = [
      { id: 'tab-a', sessionId: 'ses_a', pendingQuestions: [] },
      { id: 'tab-b', sessionId: 'ses_b', pendingQuestions: [] },
    ];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showAskUserQuestionDialog!(questionJson('q_b1', 'ses_b'));

    expect(h.openAskUserQuestionDialog).not.toHaveBeenCalled();
    expect(tabs[1].pendingQuestions).toHaveLength(1);
    expect(tabs[1].pendingQuestions![0].requestId).toBe('q_b1');
    expect(tabs[0].pendingQuestions).toHaveLength(0);
  });

  it('shows the question in the active window when NO tab claims the session', () => {
    const tabs: FakeTab[] = [{ id: 'tab-a', sessionId: 'ses_a', pendingQuestions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showAskUserQuestionDialog!(questionJson('q_x', 'ses_unbound'));

    expect(h.openAskUserQuestionDialog).toHaveBeenCalledTimes(1);
    expect(h.openAskUserQuestionDialog.mock.calls[0][0].sessionId).toBe('ses_unbound');
  });

  it('opens the question immediately for the active session', () => {
    const tabs: FakeTab[] = [{ id: 'tab-a', sessionId: 'ses_a', pendingQuestions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showAskUserQuestionDialog!(questionJson('q_a1', 'ses_a'));

    expect(h.openAskUserQuestionDialog).toHaveBeenCalledTimes(1);
    expect(tabs[0].pendingQuestions).toHaveLength(0);
  });

  it('forceCloseAskUserQuestionDialog removes the question from the background tab', () => {
    const tabs: FakeTab[] = [{ id: 'tab-b', sessionId: 'ses_b', pendingQuestions: [] }];
    const h = createHarness(tabs, 'tab-a');
    window.__sessionTabsStore = createTabsStore(tabs, 'tab-a') as unknown as typeof window.__sessionTabsStore;

    window.showAskUserQuestionDialog!(questionJson('q_b1', 'ses_b'));
    expect(tabs[0].pendingQuestions).toHaveLength(1);

    window.forceCloseAskUserQuestionDialog!('q_b1');

    expect(h.forceCloseAskUserQuestionDialog).toHaveBeenCalledWith('q_b1');
    expect(tabs[0].pendingQuestions).toHaveLength(0);
  });

  it('drains questions queued before React mounted', () => {
    window.__pendingAskUserQuestionDialogRequests = [questionJson('q_pre', 'ses_a')];
    const h = createHarness([], 'tab-a');

    expect(window.__pendingAskUserQuestionDialogRequests).toHaveLength(0);
    expect(h.openAskUserQuestionDialog).toHaveBeenCalledTimes(1);
  });
});
