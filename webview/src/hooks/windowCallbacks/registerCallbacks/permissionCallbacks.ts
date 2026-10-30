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
  // The event carries a named payload (`{ message }`); the legacy window
  // callback passed the string positionally, so accept both shapes.
  const showToast = (payload: unknown) => {
    const message = typeof payload === 'string'
      ? payload
      : String((payload as { message?: unknown } | undefined)?.message ?? '');
    cardDebugLog(`[PCard][webview] showToast: ${message}`);
    if (message) {
      addToast(message, 'error');
    }
  };

  // A question reply failed server-side — flip the optimistic "answered"
  // record back to an honest skipped state.
  // The semantic event carries a named payload (`{ requestId }`); the legacy
  // window callback passed the id positionally, so accept both shapes.
  const handleInvalidateQuestionCard = (payload: unknown) => {
    const requestId = typeof payload === 'string'
      ? payload
      : String((payload as { requestId?: unknown } | undefined)?.requestId ?? '');
    cardDebugLog(`[PCard][webview] invalidateQuestionCard called: requestId=${requestId}`);
    if (requestId) {
      removeQuestionAnswerByRequestId(requestId);
    }
    invalidateQuestionCard?.(requestId);
  };

  // A prompt is owned by a tab, not by whichever page is on screen. The dialog
  // layer appends it to that tab's queue (projection of the active tab), so a
  // background tab keeps it until the user selects it; the current view gate
  // lives in AppDialogs (`promptsVisible`).
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
      openPermissionDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse permission request:', error);
    }
  };

  // The host publishes a close when it already resolved the request (server
  // close / safety net): drop it from every tab so the badge cannot stay lit.
  const handleForceClosePermissionDialog = (payload: HostEventPayload) => {
    const channelId = String(payload?.requestId ?? '');
    forceClosePermissionDialog(channelId || null);
  };

  const handleForceCloseAskUserQuestionDialog = (payload: HostEventPayload) => {
    const requestId = String(payload?.requestId ?? '');
    forceCloseAskUserQuestionDialog(requestId || null);
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
      openPlanApprovalDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse plan approval request:', error);
    }
  };

  // The semantic catalog is the routing table; there is no `window.<fn>` path.
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
}
