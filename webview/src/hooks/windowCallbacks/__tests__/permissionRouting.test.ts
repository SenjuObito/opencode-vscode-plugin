// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPermissionCallbacks } from '../registerCallbacks/permissionCallbacks';
import { getTabStore, resetTabStore } from '../../../store/tabStore';
import type { SessionTabData } from '../../../components/ChatHeader/types';

/**
 * §10.7 / §10.8：后台 tab 的权限与提问请求怎么路由。
 *
 * 规则（与 idea 同一套）：
 *  1. 请求带 tabId 且不属于当前活跃 tab → 挂到那个 tab 的记录上，切过去再弹；
 *  2. 找不到归属 tab（已关闭 / 视图重载）→ **当场弹出**，绝不丢弃；
 *     丢弃等于服务端永远等一个没人能答的 prompt；
 *  3. 服务端把请求关掉 → 从所有 tab 上摘掉同一份，否则角标一直亮。
 */
const makeTab = (id: string): SessionTabData => ({
  id,
  sessionId: null,
  title: '',
  messages: [],
  pendingPermissions: [],
  pendingQuestions: [],
  pendingPlans: [],
} as SessionTabData);

const setup = () => {
  const openPermissionDialog = vi.fn();
  const openAskUserQuestionDialog = vi.fn();
  const forceClosePermissionDialog = vi.fn();
  const forceCloseAskUserQuestionDialog = vi.fn();

  registerPermissionCallbacks({
    addToast: vi.fn(),
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog: vi.fn(),
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog: vi.fn(),
    invalidateQuestionCard: vi.fn(),
    invalidatePermissionCard: vi.fn(),
  } as never);

  return {
    openPermissionDialog,
    openAskUserQuestionDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
  };
};

const tabById = (id: string) => getTabStore().findById(id);

describe('permission/question 路由：后台 tab 挂起，认不到 tab 就当场弹', () => {
  beforeEach(() => {
    resetTabStore();
    const store = getTabStore();
    store.setTabs([makeTab('tab-a'), makeTab('tab-b')]);
    store.setActiveTabId('tab-a');
  });

  it('别的 tab 的权限请求挂到那个 tab 上，不打断当前对话', () => {
    const { openPermissionDialog } = setup();

    window.showPermissionDialog?.(JSON.stringify({
      channelId: 'call_1',
      toolName: 'bash',
      tabId: 'tab-b',
      sessionId: 'ses_b',
    }));

    expect(openPermissionDialog).not.toHaveBeenCalled();
    const parked = tabById('tab-b')?.pendingPermissions ?? [];
    expect(parked).toHaveLength(1);
    expect(parked[0].channelId).toBe('call_1');
    expect(tabById('tab-a')?.pendingPermissions ?? []).toHaveLength(0);
  });

  it('认不到归属 tab 时当场弹出（不能丢，服务端还在等答复）', () => {
    const { openPermissionDialog } = setup();

    window.showPermissionDialog?.(JSON.stringify({
      channelId: 'call_gone',
      toolName: 'bash',
      tabId: 'tab-closed',
      sessionId: 'ses_gone',
    }));

    expect(openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(openPermissionDialog.mock.calls[0][0].channelId).toBe('call_gone');
  });

  it('当前活跃 tab 的请求直接弹', () => {
    const { openPermissionDialog } = setup();

    window.showPermissionDialog?.(JSON.stringify({
      channelId: 'call_now',
      toolName: 'bash',
      tabId: 'tab-a',
      sessionId: 'ses_a',
    }));

    expect(openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(tabById('tab-a')?.pendingPermissions ?? []).toHaveLength(0);
  });

  it('没有身份的请求直接丢弃（无从答复，弹出来只会挂死）', () => {
    const { openPermissionDialog } = setup();

    window.showPermissionDialog?.(JSON.stringify({ toolName: 'bash' }));

    expect(openPermissionDialog).not.toHaveBeenCalled();
  });

  it('提问请求走同一套：挂到 tab 上', () => {
    const { openAskUserQuestionDialog } = setup();

    window.showAskUserQuestionDialog?.(JSON.stringify({
      requestId: 'q_1',
      toolName: 'ask',
      tabId: 'tab-b',
      sessionId: 'ses_b',
      questions: [],
    }));

    expect(openAskUserQuestionDialog).not.toHaveBeenCalled();
    expect(tabById('tab-b')?.pendingQuestions ?? []).toHaveLength(1);
  });

  it('服务端关闭后从所有 tab 上摘掉同一份（角标要灭）', () => {
    setup();

    window.showPermissionDialog?.(JSON.stringify({
      channelId: 'call_1',
      toolName: 'bash',
      tabId: 'tab-b',
      sessionId: 'ses_b',
    }));
    expect(tabById('tab-b')?.pendingPermissions ?? []).toHaveLength(1);

    window.forceClosePermissionDialog?.('call_1');

    expect(tabById('tab-b')?.pendingPermissions ?? []).toHaveLength(0);
  });
});
