/**
 * permissionCallbacks.ts
 *
 * Registers window bridge callbacks for permission dialogs:
 * showPermissionDialog, showAskUserQuestionDialog, showPlanApprovalDialog.
 * Also drains any pending dialog requests queued before React mounted.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { cardDebugLog } from '../../../utils/bridge';
import { setQuestionAnswer } from '../../../store/questionAnswerStore';
import { getTabStore } from '../../../store/tabStore';
import { drainPromptsForTab, enqueuePrompt, removeQueuedPrompt, type QueuedPromptKind } from '../../../utils/pendingPromptQueue';

/**
 * 后台 tab 的 prompt 先排队，切过去再弹。
 *
 * 记住最近一次注册的回调：切 tab 时由 `flushQueuedPrompts` 调回来，
 * 而它不在 React 树里（由 App 的 effect 触发）。
 */
let activeHandlers: {
  permission: ((request: Record<string, unknown>) => void) | null;
  question: ((request: Record<string, unknown>) => void) | null;
  plan: ((request: Record<string, unknown>) => void) | null;
} = { permission: null, question: null, plan: null };

/** 该请求是否属于别的 tab（属于就先排队，别打断当前对话）。 */
function shouldDefer(request: Record<string, unknown>): boolean {
  const tabId = typeof request.tabId === 'string' ? request.tabId : '';
  if (!tabId) {
    return false;
  }
  const activeTabId = getTabStore().getActiveTabId();
  return !!activeTabId && tabId !== activeTabId;
}

function routePrompt(
  kind: QueuedPromptKind,
  request: Record<string, unknown>,
  open: ((request: never) => void) | ((request: Record<string, unknown>) => void) | null | undefined,
): void {
  if (shouldDefer(request) && open) {
    cardDebugLog(`[PCard][webview] deferring ${kind} to tab ${String(request.tabId)}`);
    enqueuePrompt({ kind, tabId: String(request.tabId), request });
    return;
  }
  (open as ((request: Record<string, unknown>) => void) | undefined)?.(request);
}

/** 切到某个 tab 时把排队中的 prompt 弹出来（App 在 activeTabId 变化时调用）。 */
export function flushQueuedPrompts(tabId: string | null | undefined): void {
  for (const prompt of drainPromptsForTab(tabId)) {
    const handler = activeHandlers[prompt.kind];
    try {
      handler?.(prompt.request);
    } catch {
      // 单个卡片失败不影响其余排队项
    }
  }
}

export function registerPermissionCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    addToast,
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    invalidateQuestionCard,
    invalidatePermissionCard,
  } = options;

  // Host-side failures (e.g. opencode.replyQuestion / replyPermission errors
  // surfaced by PermissionHandler, or daemon startup errors) land here as a user-visible toast.
  window.showToast = (message) => {
    cardDebugLog(`[PCard][webview] showToast: ${message}`);
    addToast(String(message ?? ''), 'error');
  };

  if (Array.isArray(window.__pendingToasts) && window.__pendingToasts.length > 0) {
    for (const msg of window.__pendingToasts) {
      cardDebugLog(`[PCard][webview] draining pending showToast: ${msg}`);
      addToast(String(msg ?? ''), 'error');
    }
    delete window.__pendingToasts;
  }

  // A question reply failed server-side — flip the optimistic "answered"
  // record back to an honest skipped state.
  window.invalidateQuestionCard = (requestId) => {
    cardDebugLog(`[PCard][webview] invalidateQuestionCard called: requestId=${requestId}`);
    invalidateQuestionCard?.(requestId ?? '');
  };

  // A permission reply failed server-side — flip the optimistic
  // approved/denied record back to a denied state.
  window.invalidatePermissionCard = (channelId) => {
    cardDebugLog(`[PCard][webview] invalidatePermissionCard called: channelId=${channelId}`);
    invalidatePermissionCard?.(channelId ?? '');
  };

  // 排队项来自 JSON，只能以 Record 传递；具体形状由各自的 open* 负责校验，
  // 所以这里做一次显式收窄（否则每个 handler 都要在队列里保留自己的强类型）。
  type RequestOpener = (request: Record<string, unknown>) => void;
  activeHandlers = {
    permission: (openPermissionDialog as unknown as RequestOpener) ?? null,
    question: (openAskUserQuestionDialog as unknown as RequestOpener) ?? null,
    plan: (openPlanApprovalDialog as unknown as RequestOpener) ?? null,
  };

  window.showPermissionDialog = (json) => {
    try {
      const request = JSON.parse(json);
      console.log(`[PCard][webview] showPermissionDialog channelId=${request.channelId} toolName=${request.toolName}`);
      routePrompt('permission', request, openPermissionDialog);
    } catch (error) {
      console.error('[Frontend] Failed to parse permission request:', error);
    }
  };

  // The Java backend calls these when its safety-net timer fires after the
  // permission/ask/plan dialog future has already been resolved with a default
  // (DENY / empty answers). Without an explicit close signal the WebView's
  // openRefs stay true, every subsequent show*Dialog enqueues silently behind
  // the orphaned dialog, and the user appears to "lose" all further prompts
  // until they reload the tab — see issue #1360.
  window.forceClosePermissionDialog = (channelId) => {
    // 服务端已关闭（答复/超时/关 tab）：队列里的同一请求也必须摘掉，
    // 否则切回该 tab 会弹出一张失效的卡片。
    removeQueuedPrompt('permission', String(channelId ?? ''));
    forceClosePermissionDialog(channelId ?? null);
  };

  window.forceCloseAskUserQuestionDialog = (requestId) => {
    removeQueuedPrompt('question', String(requestId ?? ''));
    forceCloseAskUserQuestionDialog(requestId ?? null);
  };

  window.forceClosePlanApprovalDialog = (requestId) => {
    forceClosePlanApprovalDialog(requestId ?? null);
  };

  if (
    Array.isArray(window.__pendingPermissionDialogRequests) &&
    window.__pendingPermissionDialogRequests.length > 0
  ) {
    const pending = window.__pendingPermissionDialogRequests.slice();
    window.__pendingPermissionDialogRequests = [];
    for (const payload of pending) {
      window.showPermissionDialog?.(payload);
    }
  }

  window.showAskUserQuestionDialog = (json) => {
    try {
      const request = JSON.parse(json);
      cardDebugLog(`[QCard][webview] showAskUserQuestionDialog requestId=${request.requestId} toolName=${request.toolName} questions=${request.questions?.length ?? 0}`);
      routePrompt('question', request, openAskUserQuestionDialog);
    } catch (error) {
      console.error('[Frontend] Failed to parse ask user question request:', error);
    }
  };

  // Host sends complete Q&A data after the user answers.
  window.onQuestionAnswered = (json) => {
    try {
      const data = JSON.parse(json);
      console.log(`[PCard][webview] onQuestionAnswered callId="${data.callId}" requestId="${data.requestId}" questions=${data.questions?.length ?? 0} answers=`, data.answers);
      cardDebugLog(`[QCard][webview] onQuestionAnswered callId=${data.callId} requestId=${data.requestId}`);
      setQuestionAnswer(data);
    } catch (error) {
      console.error('[Frontend] Failed to parse onQuestionAnswered:', error);
    }
  };

  if (
    Array.isArray(window.__pendingAskUserQuestionDialogRequests) &&
    window.__pendingAskUserQuestionDialogRequests.length > 0
  ) {
    const pending = window.__pendingAskUserQuestionDialogRequests.slice();
    window.__pendingAskUserQuestionDialogRequests = [];
    for (const payload of pending) {
      window.showAskUserQuestionDialog?.(payload);
    }
  }

  window.showPlanApprovalDialog = (json) => {
    try {
      const request = JSON.parse(json);
      routePrompt('plan', request, openPlanApprovalDialog);
    } catch (error) {
      console.error('[Frontend] Failed to parse plan approval request:', error);
    }
  };

  if (
    Array.isArray(window.__pendingPlanApprovalDialogRequests) &&
    window.__pendingPlanApprovalDialogRequests.length > 0
  ) {
    const pending = window.__pendingPlanApprovalDialogRequests.slice();
    window.__pendingPlanApprovalDialogRequests = [];
    for (const payload of pending) {
      window.showPlanApprovalDialog?.(payload);
    }
  }
}
