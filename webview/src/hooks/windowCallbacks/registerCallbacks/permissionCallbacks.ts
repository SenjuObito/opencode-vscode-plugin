/**
 * permissionCallbacks.ts
 *
 * Registers window bridge callbacks for permission dialogs:
 * showPermissionDialog, showAskUserQuestionDialog, showPlanApprovalDialog.
 * Also drains any pending dialog requests queued before React mounted.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { cardDebugLog } from '../../../utils/bridge';
import { registerHostEvents } from '../../../utils/hostEventRegistry';
import { setQuestionAnswer, removeQuestionAnswerByRequestId } from '../../../store/questionAnswerStore';
import type { HostEventPayload } from '../../../utils/hostEventTypes';
import { getTabStore } from '../../../store/tabStore';
import { owningTabIdForSession } from '../tabTransition';

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
  } = options;

  // Host-side failures (e.g. opencode.replyQuestion / replyPermission errors
  // surfaced by PermissionHandler, or daemon startup errors) land here as a user-visible toast.
  const showToast = (message: unknown) => {
    cardDebugLog(`[PCard][webview] showToast: ${message}`);
    addToast(String(message ?? ''), 'error');
  };

  // A question reply failed server-side — flip the optimistic "answered"
  // record back to an honest skipped state.
  const handleInvalidateQuestionCard = (requestId: string) => {
    cardDebugLog(`[PCard][webview] invalidateQuestionCard called: requestId=${requestId}`);
    if (requestId) {
      removeQuestionAnswerByRequestId(requestId);
    }
    invalidateQuestionCard?.(requestId ?? '');
  };

  // A permission reply failed server-side — flip the optimistic
  // approved/denied record back to a denied state.
  const showPermissionDialog = (payload: HostEventPayload | undefined) => {
    try {
      const request = payload as any;
      if (!request || !request.channelId) {
        // A prompt without an identity cannot be answered: dropping it is the
        // only behaviour that can neither mis-route nor corrupt.
        cardDebugLog('[PCard][webview] dropping a permission prompt without an id');
        return;
      }
      cardDebugLog(`[PCard][webview] showPermissionDialog channelId=${request.channelId} toolName=${request.toolName} sessionId=${request.sessionId} tabId=${request.tabId}`);
      const targetSessionId = request.sessionId;
      const tabStore = getTabStore();
      // The host stamps the owning tab: routing by tab id is exact, routing by
      // session id only finds the tab when it happens to be bound already.
      const targetTabId = typeof request.tabId === 'string' && request.tabId ? request.tabId : null;

      const ownerTabId = targetTabId ?? owningTabIdForSession(targetSessionId);
      const isCurrentActive = ownerTabId
        ? tabStore.isActiveTab(ownerTabId)
        : !targetSessionId;

      if (!isCurrentActive && (targetTabId || targetSessionId)) {
        const enqueue = (t: any) => {
          const list = t.pendingPermissions || [];
          if (!list.some((r: any) => r.channelId === request.channelId)) {
            t.pendingPermissions = [...list, request];
          }
        };
        const stored = ownerTabId ? tabStore.updateTab(ownerTabId, enqueue) : false;
        if (stored) {
          return;
        }
        cardDebugLog(
          `[PCard][webview] background tab not found for ${targetTabId || targetSessionId}; showing permission prompt in the active window instead of dropping it`
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
  const handleForceClosePermissionDialog = (payload: HostEventPayload) => {
    const channelId = String(payload?.requestId ?? '');
    forceClosePermissionDialog(channelId || null);
    if (channelId) {
      getTabStore().updateAllTabs((t) => {
        if (t.pendingPermissions) {
          t.pendingPermissions = t.pendingPermissions.filter((r: any) => r.channelId !== channelId);
        }
      });
    }
  };

  const handleForceCloseAskUserQuestionDialog = (payload: HostEventPayload) => {
    const requestId = String(payload?.requestId ?? '');
    forceCloseAskUserQuestionDialog(requestId || null);
    if (requestId) {
      getTabStore().updateAllTabs((t) => {
        if (t.pendingQuestions) {
          t.pendingQuestions = t.pendingQuestions.filter((r: any) => r.requestId !== requestId);
        }
      });
    }
  };

  const handleForceClosePlanApprovalDialog = (payload: HostEventPayload) => {
    const requestId = String(payload?.requestId ?? '');
    forceClosePlanApprovalDialog(requestId || null);
  };

  const showAskUserQuestionDialog = (payload: HostEventPayload | undefined) => {
    try {
      const request = payload as any;
      if (!request || !request.requestId) {
        cardDebugLog('[QCard][webview] dropping a question without an id');
        return;
      }
      cardDebugLog(`[QCard][webview] showAskUserQuestionDialog requestId=${request.requestId} toolName=${request.toolName} questions=${request.questions?.length ?? 0} sessionId=${request.sessionId} tabId=${request.tabId}`);
      const targetSessionId = request.sessionId;
      const tabStore = getTabStore();
      const targetTabId = typeof request.tabId === 'string' && request.tabId ? request.tabId : null;

      const ownerTabId = targetTabId ?? owningTabIdForSession(targetSessionId);
      const isCurrentActive = ownerTabId
        ? tabStore.isActiveTab(ownerTabId)
        : !targetSessionId;

      if (!isCurrentActive && (targetTabId || targetSessionId)) {
        const enqueue = (t: any) => {
          const list = t.pendingQuestions || [];
          if (!list.some((r: any) => r.requestId === request.requestId)) {
            t.pendingQuestions = [...list, request];
          }
        };
        const stored = ownerTabId ? tabStore.updateTab(ownerTabId, enqueue) : false;
        if (stored) {
          return;
        }
        cardDebugLog(
          `[QCard][webview] background tab not found for ${targetTabId || targetSessionId}; showing question prompt in active window`
        );
      }

      openAskUserQuestionDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse ask user question request:', error);
    }
  };

  // Host sends complete Q&A data after the user answers.
  const onQuestionAnswered = (json: string) => {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      cardDebugLog(`[PCard][webview] onQuestionAnswered callId="${data.callId}" requestId="${data.requestId}" questions=${data.questions?.length ?? 0} answers=`, data.answers);
      cardDebugLog(`[QCard][webview] onQuestionAnswered callId=${data.callId} requestId=${data.requestId}`);
      setQuestionAnswer(data);
    } catch (error) {
      console.error('[Frontend] Failed to parse onQuestionAnswered:', error);
    }
  };

  const showPlanApprovalDialog = (payload: HostEventPayload | undefined) => {
    try {
      const request = payload as any;
      if (!request || !request.requestId) {
        cardDebugLog('[PlanApproval][webview] dropping a plan approval without an id');
        return;
      }
      const targetTabId = typeof request.tabId === 'string' ? request.tabId : null;
      const tabStore = getTabStore();
      const ownerTabId = targetTabId ?? owningTabIdForSession(request.sessionId);
      if (ownerTabId && !tabStore.isActiveTab(ownerTabId)) {
        // A background tab's plan approval waits in that tab's queue instead of
        // stealing the foreground.
        const stored = tabStore.updateTab(ownerTabId, (t: any) => {
          const list = t.pendingPlans || [];
          if (!list.some((r: any) => r.requestId === request.requestId)) {
            t.pendingPlans = [...list, request];
          }
        });
        if (stored) {
          cardDebugLog('[PlanApproval][webview] queued the approval in tab', targetTabId);
          return;
        }
      }
      openPlanApprovalDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse plan approval request:', error);
    }
  };

  // The semantic catalog is the routing table.
  registerHostEvents({
    'prompt.question.closed': handleForceCloseAskUserQuestionDialog,
    'prompt.closed': handleForceClosePermissionDialog,
    'prompt.plan.closed': handleForceClosePlanApprovalDialog,
    'question.requested': showAskUserQuestionDialog,
    'permission.requested': showPermissionDialog,
    'plan.requested': showPlanApprovalDialog,
    'question.answered': onQuestionAnswered,
    'question.invalidated': handleInvalidateQuestionCard,
    'toast.error': showToast,
  });

  // Backward compatibility aliases for tests and legacy callers:
  window.showPermissionDialog = (raw: any) => {
    try {
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      showPermissionDialog(payload);
    } catch {
      // ignore
    }
  };
  window.showAskUserQuestionDialog = (raw: any) => {
    try {
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      showAskUserQuestionDialog(payload);
    } catch {
      // ignore
    }
  };
  window.showPlanApprovalDialog = (raw: any) => {
    try {
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      showPlanApprovalDialog(payload);
    } catch {
      // ignore
    }
  };
  window.forceClosePermissionDialog = (id: any) => {
    handleForceClosePermissionDialog({ requestId: id });
  };
  window.forceCloseAskUserQuestionDialog = (id: any) => {
    handleForceCloseAskUserQuestionDialog({ requestId: id });
  };
  window.forceClosePlanApprovalDialog = (id: any) => {
    handleForceClosePlanApprovalDialog({ requestId: id });
  };
}
