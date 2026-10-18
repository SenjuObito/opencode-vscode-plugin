/**
 * permissionCallbacks.ts
 *
 * Registers window bridge callbacks for permission dialogs:
 * showPermissionDialog, showAskUserQuestionDialog, showPlanApprovalDialog.
 * Also drains any pending dialog requests queued before React mounted.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { cardDebugLog } from '../../../utils/bridge';
import { setQuestionAnswer, removeQuestionAnswerByRequestId } from '../../../store/questionAnswerStore';

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
    if (requestId) {
      removeQuestionAnswerByRequestId(requestId);
    }
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
      cardDebugLog(`[PCard][webview] showPermissionDialog channelId=${request.channelId} toolName=${request.toolName} sessionId=${request.sessionId}`);
      const targetSessionId = request.sessionId;
      const tabsStore = window.__sessionTabsStore;

      if (targetSessionId && tabsStore && !tabsStore.isActiveSession(targetSessionId)) {
        const stored = tabsStore.updateBackgroundTab(
          (t) => t.sessionId === targetSessionId || t.id === targetSessionId,
          (t) => {
            const list = t.pendingPermissions || [];
            if (!list.some((r: any) => r.channelId === request.channelId)) {
              t.pendingPermissions = [...list, request];
            }
          }
        );
        // `stored === false` means no tab claims this session yet. Previously the
        // prompt was dropped here and the server later settled it as rejected —
        // the user saw a "已取消" card without ever seeing a dialog.
        //
        // Showing it in the active window is the lesser evil: the *reply* is
        // routed by permission id through OpencodePermissionRegistry (which
        // carries the request's own sessionId + directory), so answering here
        // still reaches the right session. Only the visual placement can be off,
        // and a misplaced dialog beats a lost prompt.
        if (stored) {
          return;
        }
        cardDebugLog(
          `[PCard][webview] no tab for sessionId=${targetSessionId}; showing permission prompt in the active window instead of dropping it`
        );
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
    forceClosePermissionDialog(channelId ?? null);
    if (channelId && window.__sessionTabsStore) {
      window.__sessionTabsStore.updateBackgroundTab(
        () => true,
        (t) => {
          if (t.pendingPermissions) {
            t.pendingPermissions = t.pendingPermissions.filter((r: any) => r.channelId !== channelId);
          }
        }
      );
    }
  };

  window.forceCloseAskUserQuestionDialog = (requestId) => {
    forceCloseAskUserQuestionDialog(requestId ?? null);
    if (requestId && window.__sessionTabsStore) {
      window.__sessionTabsStore.updateBackgroundTab(
        () => true,
        (t) => {
          if (t.pendingQuestions) {
            t.pendingQuestions = t.pendingQuestions.filter((r: any) => r.requestId !== requestId);
          }
        }
      );
    }
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
      cardDebugLog(`[QCard][webview] showAskUserQuestionDialog requestId=${request.requestId} toolName=${request.toolName} questions=${request.questions?.length ?? 0} sessionId=${request.sessionId}`);
      const targetSessionId = request.sessionId;
      const tabsStore = window.__sessionTabsStore;

      if (targetSessionId && tabsStore && !tabsStore.isActiveSession(targetSessionId)) {
        const stored = tabsStore.updateBackgroundTab(
          (t) => t.sessionId === targetSessionId || t.id === targetSessionId,
          (t) => {
            const list = t.pendingQuestions || [];
            if (!list.some((r: any) => r.requestId === request.requestId)) {
              t.pendingQuestions = [...list, request];
            }
          }
        );
        // Same reasoning as permissions: never lose a prompt just because no tab
        // claims the session yet.
        if (stored) {
          return;
        }
        cardDebugLog(
          `[QCard][webview] no tab for sessionId=${targetSessionId}; showing question prompt in the active window instead of dropping it`
        );
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
      cardDebugLog(`[PCard][webview] onQuestionAnswered callId="${data.callId}" requestId="${data.requestId}" questions=${data.questions?.length ?? 0} answers=`, data.answers);
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
