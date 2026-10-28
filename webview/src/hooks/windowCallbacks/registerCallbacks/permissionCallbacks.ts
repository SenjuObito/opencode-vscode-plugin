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
import type { SessionTabData } from '../../../components/ChatHeader/types';

/**
 * 后台 tab 的 prompt 怎么处理（§10.7 / 10.8，与 idea 同一套机制）。
 *
 * 请求**直接挂在那个 tab 的记录上**（`pendingPermissions` / `pendingQuestions` /
 * `pendingPlans`），不另建队列：
 *   - 角标直接读 tab 记录（`SessionTabBar` 本来就这么渲染）；
 *   - 切 tab 时由 `useTabLifecycle` 调 `window.__dialogStore.restore(...)` 接管。
 *
 * 之前这里放了一个模块级 Map 队列，副本和 tab 记录各存一份，导致两个偏差：
 * tab 已关时请求永远没人取（服务端干等）、force-close 清不掉角标。
 */

/** 请求属于哪个 tab：宿主盖章的 tabId 优先，sessionId 只在已绑定时可反查。 */
function owningTabId(tabId: unknown, sessionId: unknown): string | null {
  if (typeof tabId === 'string' && tabId) {
    return tabId;
  }
  if (typeof sessionId === 'string' && sessionId) {
    return getTabStore().findIdBySession(sessionId);
  }
  return null;
}

type PendingField = 'pendingPermissions' | 'pendingQuestions' | 'pendingPlans';

/**
 * 把请求挂到它的 tab 上，等切过去再弹。
 *
 * @returns true = 已挂上（调用方直接 return）；false = 找不到那个 tab
 *          （已关闭 / 视图重载），调用方必须**当场弹出**——丢一张等于服务端
 *          永远等一个没人能答的 prompt。
 */
function parkPromptOnTab(
  owner: string | null,
  field: PendingField,
  idKey: 'channelId' | 'requestId',
  request: Record<string, unknown>,
): boolean {
  if (!owner) {
    return false;
  }
  const id = String(request?.[idKey] ?? '');
  return getTabStore().updateTab(owner, (tab) => {
    const record = tab as unknown as Record<string, unknown>;
    const list = (record[field] as Record<string, unknown>[] | undefined) ?? [];
    if (list.some((item) => String(item?.[idKey] ?? '') === id)) {
      return;
    }
    record[field] = [...list, request];
  });
}

/** 这个请求是不是同一个 webview 正在显示的那个 tab 的。 */
function isForActiveTab(owner: string | null, sessionId: unknown): boolean {
  if (owner) {
    return getTabStore().isActiveTab(owner);
  }
  // 没有任何归属可用（极早期 / 窗口级）：当作当前窗口的，直接弹。
  return !sessionId;
}

/** 关掉某个 id 的请求后，把残留在任意 tab 上的同一份摘掉（否则角标不灭）。 */
function clearParkedPrompt(field: PendingField, idKey: 'channelId' | 'requestId', id: string): void {
  if (!id) {
    return;
  }
  getTabStore().updateAllTabs((tab: SessionTabData) => {
    const record = tab as unknown as Record<string, unknown>;
    const list = record[field] as Record<string, unknown>[] | undefined;
    if (!list || list.length === 0) {
      return;
    }
    record[field] = list.filter((item) => String(item?.[idKey] ?? '') !== id);
  });
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

  window.showPermissionDialog = (json) => {
    try {
      const request = JSON.parse(json);
      if (!request?.channelId) {
        // 没有身份就无从答复：丢掉既不会误路由，也不会污染别人的卡片。
        cardDebugLog('[PCard][webview] dropping a permission prompt without an id');
        return;
      }
      console.log(`[PCard][webview] showPermissionDialog channelId=${request.channelId} toolName=${request.toolName} tabId=${request.tabId}`);
      const owner = owningTabId(request.tabId, request.sessionId);
      if (!isForActiveTab(owner, request.sessionId)) {
        if (parkPromptOnTab(owner, 'pendingPermissions', 'channelId', request)) {
          cardDebugLog(`[PCard][webview] parked permission ${request.channelId} on tab ${owner}`);
          return;
        }
        cardDebugLog(`[PCard][webview] owner tab not found for ${String(request.tabId ?? request.sessionId)}; showing in the active window`);
      }
      openPermissionDialog(request);
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
    // 服务端已关闭（答复/超时/关 tab）：tab 上挂着的同一请求也要摘掉，
    // 否则切回该 tab 会弹出一张失效的卡片，角标也一直亮着。
    const id = String(channelId ?? '');
    forceClosePermissionDialog(id || null);
    clearParkedPrompt('pendingPermissions', 'channelId', id);
  };

  window.forceCloseAskUserQuestionDialog = (requestId) => {
    const id = String(requestId ?? '');
    forceCloseAskUserQuestionDialog(id || null);
    clearParkedPrompt('pendingQuestions', 'requestId', id);
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
      if (!request?.requestId) {
        cardDebugLog('[QCard][webview] dropping a question without an id');
        return;
      }
      cardDebugLog(`[QCard][webview] showAskUserQuestionDialog requestId=${request.requestId} toolName=${request.toolName} questions=${request.questions?.length ?? 0} tabId=${request.tabId}`);
      const owner = owningTabId(request.tabId, request.sessionId);
      if (!isForActiveTab(owner, request.sessionId)) {
        if (parkPromptOnTab(owner, 'pendingQuestions', 'requestId', request)) {
          cardDebugLog(`[QCard][webview] parked question ${request.requestId} on tab ${owner}`);
          return;
        }
        cardDebugLog(`[QCard][webview] owner tab not found for ${String(request.tabId ?? request.sessionId)}; showing in the active window`);
      }
      openAskUserQuestionDialog(request);
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
      if (!request?.requestId) {
        cardDebugLog('[PlanApproval][webview] dropping a plan approval without an id');
        return;
      }
      const owner = owningTabId(request.tabId, request.sessionId);
      if (owner && !getTabStore().isActiveTab(owner)) {
        // 后台 tab 的计划确认不该抢前台：挂到它的记录上，切过去再弹。
        if (parkPromptOnTab(owner, 'pendingPlans', 'requestId', request)) {
          cardDebugLog('[PlanApproval][webview] parked on tab', owner);
          return;
        }
      }
      openPlanApprovalDialog(request);
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
