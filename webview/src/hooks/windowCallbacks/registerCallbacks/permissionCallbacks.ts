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
  // surfaced by PermissionHandler) land here as a user-visible toast.
  window.showToast = (message) => {
    cardDebugLog(`[PCard][webview] showToast: ${message}`);
    addToast(String(message ?? ''), 'error');
  };

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
      console.log(`[PCard][webview] showPermissionDialog channelId=${request.channelId} toolName=${request.toolName}`);
      openPermissionDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse permission request:', error);
    }
  };

  // The host backend calls these when its safety-net timer fires after the
  // permission/ask/plan dialog future has already been resolved with a default
  // (DENY / empty answers). Without an explicit close signal the WebView's
  // openRefs stay true, every subsequent show*Dialog enqueues silently behind
  // the orphaned dialog, and the user appears to "lose" all further prompts
  // until they reload the tab — see issue #1360.
  window.forceClosePermissionDialog = (channelId) => {
    forceClosePermissionDialog(channelId ?? null);
  };

  window.forceCloseAskUserQuestionDialog = (requestId) => {
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
