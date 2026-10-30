// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPermissionCallbacks } from '../registerCallbacks/permissionCallbacks';
import { dispatchHostEnvelope } from '../../../utils/hostDispatcher';
import { resetTabStore } from '../../../store/tabStore';

/**
 * §10.7 / §10.8：权限 / 提问事件如何进入对话框层。
 *
 * 规则（与 idea 同一套）：
 *  1. 注册回调只做「解析 + 投递」：带 id 的请求一律交给 `openPermissionDialog`
 *     / `openAskUserQuestionDialog`，由对话框层按 `tabId` 落到所属 tab 的队列；
 *  2. 没有 id 的请求直接丢弃（无从答复，弹出来只会挂死）；
 *  3. 服务端把请求关掉 → 交给 `forceClose*`，由对话框层从所有 tab 上摘掉。
 *
 * 队列归属本身（后台 tab 挂起、切过去再弹）由 `useDialogManagement` 负责，
 * 见 `useDialogManagement.forceClose.test.ts`。
 *
 * 宿主只发语义事件（`permission.requested` / `question.requested` /
 * `prompt.closed`），事件走 `hostDispatcher` 进注册表，没有 window 裸调用路径。
 */
const setup = () => {
  const openPermissionDialog = vi.fn();
  const openAskUserQuestionDialog = vi.fn();
  const openPlanApprovalDialog = vi.fn();
  const forceClosePermissionDialog = vi.fn();
  const forceCloseAskUserQuestionDialog = vi.fn();
  const forceClosePlanApprovalDialog = vi.fn();
  const invalidateQuestionCard = vi.fn();

  registerPermissionCallbacks({
    addToast: vi.fn(),
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    invalidateQuestionCard,
    invalidatePermissionCard: vi.fn(),
  } as never);

  return {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    invalidateQuestionCard,
  };
};

const emit = (type: string, payload: Record<string, unknown>) => {
  dispatchHostEnvelope({ v: 2, type, tabId: String(payload.tabId ?? ''), epoch: 0, payload });
};

describe('permission/question 事件投递', () => {
  beforeEach(() => {
    resetTabStore();
  });

  it('带 id 的权限请求原样投递（归属 tab 由对话框层决定）', () => {
    const { openPermissionDialog } = setup();

    emit('permission.requested', {
      channelId: 'call_1',
      toolName: 'bash',
      tabId: 'tab-b',
      sessionId: 'ses_b',
    });

    expect(openPermissionDialog).toHaveBeenCalledTimes(1);
    expect(openPermissionDialog.mock.calls[0][0]).toMatchObject({
      channelId: 'call_1',
      tabId: 'tab-b',
      sessionId: 'ses_b',
    });
  });

  it('没有身份的请求直接丢弃（无从答复，弹出来只会挂死）', () => {
    const { openPermissionDialog } = setup();

    emit('permission.requested', { toolName: 'bash' });

    expect(openPermissionDialog).not.toHaveBeenCalled();
  });

  it('提问请求走同一套投递', () => {
    const { openAskUserQuestionDialog } = setup();

    emit('question.requested', {
      requestId: 'q_1',
      toolName: 'ask',
      tabId: 'tab-b',
      sessionId: 'ses_b',
      questions: [],
    });

    expect(openAskUserQuestionDialog).toHaveBeenCalledTimes(1);
    expect(openAskUserQuestionDialog.mock.calls[0][0]).toMatchObject({
      requestId: 'q_1',
      tabId: 'tab-b',
    });
  });

  it('计划审批请求走同一套投递', () => {
    const { openPlanApprovalDialog } = setup();

    emit('plan.requested', {
      requestId: 'plan_1',
      toolName: 'ExitPlanMode',
      tabId: 'tab-b',
      sessionId: 'ses_b',
    });

    expect(openPlanApprovalDialog).toHaveBeenCalledTimes(1);
  });

  it('服务端关闭后交给 forceClose（由对话框层摘掉所有 tab 上的同一份）', () => {
    const { forceClosePermissionDialog } = setup();

    emit('prompt.closed', { requestId: 'call_1' });

    expect(forceClosePermissionDialog).toHaveBeenCalledWith('call_1');
  });

  it('question.invalidated 的命名 payload 能解析出 requestId（不是 [object Object]）', () => {
    const { invalidateQuestionCard } = setup();

    emit('question.invalidated', { requestId: 'call_q' });

    expect(invalidateQuestionCard).toHaveBeenCalledWith('call_q');
  });
});
