import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { ContextUsageData } from '../components/ContextUsageDialog';
import { sendBridgeEvent, cardDebugLog } from '../utils/bridge';
import { useSession } from '../contexts/SessionContext';

interface UseDialogManagementOptions {
  t: TFunction;
}

interface UseDialogManagementReturn {
  // Permission modal (top-level overlay; queue of pending requests)
  permissionDialogOpen: boolean;
  currentPermissionRequest: PermissionRequest | null;
  pendingPermissionRequests: PermissionRequest[];
  openPermissionDialog: (request: PermissionRequest) => void;
  handlePermissionApprove: (channelId: string) => void;
  handlePermissionApproveAlways: (channelId: string) => void;
  handlePermissionSkip: (channelId: string) => void;
  forceClosePermissionDialog: (requestId?: string | null) => void;

  // AskUserQuestion modal (top-level overlay; queue of pending requests)
  askUserQuestionDialogOpen: boolean;
  currentAskUserQuestionRequest: AskUserQuestionRequest | null;
  pendingAskUserQuestionRequests: AskUserQuestionRequest[];
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  handleAskUserQuestionSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  handleAskUserQuestionSkip: (requestId: string) => void;
  forceCloseAskUserQuestionDialog: (requestId?: string | null) => void;

  // PlanApproval dialog
  planApprovalDialogOpen: boolean;
  currentPlanApprovalRequest: PlanApprovalRequest | null;
  openPlanApprovalDialog: (request: PlanApprovalRequest) => void;
  handlePlanApprovalApprove: (requestId: string, targetMode: string) => void;
  handlePlanApprovalReject: (requestId: string) => void;
  forceClosePlanApprovalDialog: (requestId?: string | null) => void;

  // Context usage dialog
  contextUsageDialogOpen: boolean;
  contextUsageIsLoading: boolean;
  contextUsageData: ContextUsageData | null;
  openContextUsageDialog: (requestId?: string | null, loading?: boolean) => void;
  updateContextUsageData: (requestId: string | null | undefined, data: ContextUsageData) => boolean;
  closeContextUsageDialog: (requestId?: string | null) => boolean;

  // Host reply-failure teardown (delegates to forceClose)
  invalidateQuestionCard: (requestId: string) => void;
  invalidatePermissionCard: (channelId: string) => void;
}

/**
 * Hook for managing dialog states (permission, ask user question).
 *
 * Permission / question requests render as top-level modal overlays (one at a
 * time) instead of inline chat-flow cards. State is a queue: `current*Request`
 * is the active dialog; `pending*Requests` are waiting requests. On resolve the
 * current dialog closes and the next pending request is promoted. No inline
 * record is kept after a decision (matches opencode TUI / cc-gui behavior).
 */
export function useDialogManagement({ t }: UseDialogManagementOptions): UseDialogManagementReturn {
  // Permission dialog state
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PermissionRequest[]>([]);
  const permissionDialogOpenRef = useRef(false);
  const currentPermissionRequestRef = useRef<PermissionRequest | null>(null);
  const pendingPermissionRequestsRef = useRef<PermissionRequest[]>([]);

  // AskUserQuestion dialog state
  const [askUserQuestionDialogOpen, setAskUserQuestionDialogOpen] = useState(false);
  const [currentAskUserQuestionRequest, setCurrentAskUserQuestionRequest] = useState<AskUserQuestionRequest | null>(null);
  const [pendingAskUserQuestionRequests, setPendingAskUserQuestionRequests] = useState<AskUserQuestionRequest[]>([]);
  const askUserQuestionDialogOpenRef = useRef(false);
  const currentAskUserQuestionRequestRef = useRef<AskUserQuestionRequest | null>(null);
  const pendingAskUserQuestionRequestsRef = useRef<AskUserQuestionRequest[]>([]);

  // Dialogs are session-scoped: a session switch invalidates every pending request.
  const { currentSessionId } = useSession();
  const lastSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    if (currentSessionId === lastSessionIdRef.current) return;
    lastSessionIdRef.current = currentSessionId;
    setPendingPermissionRequests([]);
    setCurrentPermissionRequest(null);
    setPermissionDialogOpen(false);
    setPendingAskUserQuestionRequests([]);
    setCurrentAskUserQuestionRequest(null);
    setAskUserQuestionDialogOpen(false);
  }, [currentSessionId]);

  // PlanApproval dialog state
  const [planApprovalDialogOpen, setPlanApprovalDialogOpen] = useState(false);
  const [currentPlanApprovalRequest, setCurrentPlanApprovalRequest] = useState<PlanApprovalRequest | null>(null);
  const planApprovalDialogOpenRef = useRef(false);
  const currentPlanApprovalRequestRef = useRef<PlanApprovalRequest | null>(null);
  const pendingPlanApprovalRequestsRef = useRef<PlanApprovalRequest[]>([]);

  // Context usage dialog state
  const [contextUsageDialogOpen, setContextUsageDialogOpen] = useState(false);
  const [contextUsageIsLoading, setContextUsageIsLoading] = useState(false);
  const [contextUsageData, setContextUsageData] = useState<ContextUsageData | null>(null);
  const contextUsageRequestIdRef = useRef<string | null>(null);

  // Sync refs with state
  useEffect(() => {
    planApprovalDialogOpenRef.current = planApprovalDialogOpen;
    currentPlanApprovalRequestRef.current = currentPlanApprovalRequest;
  }, [planApprovalDialogOpen, currentPlanApprovalRequest]);

  // Sync permission/question refs with state
  useEffect(() => {
    permissionDialogOpenRef.current = permissionDialogOpen;
    currentPermissionRequestRef.current = currentPermissionRequest;
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
    askUserQuestionDialogOpenRef.current = askUserQuestionDialogOpen;
    currentAskUserQuestionRequestRef.current = currentAskUserQuestionRequest;
    pendingAskUserQuestionRequestsRef.current = pendingAskUserQuestionRequests;
  }, [permissionDialogOpen, currentPermissionRequest, pendingPermissionRequests, askUserQuestionDialogOpen, currentAskUserQuestionRequest, pendingAskUserQuestionRequests]);

  const closePermissionCurrent = useCallback(() => {
    currentPermissionRequestRef.current = null;
    setCurrentPermissionRequest(null);
    setPermissionDialogOpen(false);
  }, []);

  const closeQuestionCurrent = useCallback(() => {
    setCurrentAskUserQuestionRequest(null);
    setAskUserQuestionDialogOpen(false);
  }, []);

  // Open (or enqueue) a permission request. The first request becomes the
  // active dialog; later requests queue. Duplicates (same channelId, either
  // active or queued) are ignored.
  const openPermissionDialog = useCallback((request: PermissionRequest) => {
    cardDebugLog(`[PCard][webview] openPermissionDialog channelId=${request.channelId}`);
    if (currentPermissionRequestRef.current?.channelId === request.channelId) return;
    if (pendingPermissionRequestsRef.current.some((r) => r.channelId === request.channelId)) return;
    if (!currentPermissionRequestRef.current) {
      currentPermissionRequestRef.current = request;
      setCurrentPermissionRequest(request);
      setPermissionDialogOpen(true);
    } else {
      pendingPermissionRequestsRef.current.push(request);
      setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
    }
  }, []);

  // Open (or enqueue) an ask-user-question request. Mirrors openPermissionDialog.
  const openAskUserQuestionDialog = useCallback((request: AskUserQuestionRequest) => {
    cardDebugLog(`[QCard][webview] openAskUserQuestionDialog requestId=${request.requestId} toolName="${request.toolName}"`);
    if (currentAskUserQuestionRequestRef.current?.requestId === request.requestId) return;
    if (pendingAskUserQuestionRequestsRef.current.some((r) => r.requestId === request.requestId)) return;
    if (!currentAskUserQuestionRequestRef.current) {
      currentAskUserQuestionRequestRef.current = request;
      setCurrentAskUserQuestionRequest(request);
      setAskUserQuestionDialogOpen(true);
    } else {
      pendingAskUserQuestionRequestsRef.current.push(request);
      setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
    }
  }, []);

  // Open plan approval dialog (queue of pending requests)
  const openPlanApprovalDialog = useCallback((request: PlanApprovalRequest) => {
    if (planApprovalDialogOpenRef.current || currentPlanApprovalRequestRef.current) {
      const currentId = currentPlanApprovalRequestRef.current?.requestId;
      const alreadyQueued = pendingPlanApprovalRequestsRef.current.some(
        (item) => item.requestId === request.requestId,
      );
      if (request.requestId !== currentId && !alreadyQueued) {
        pendingPlanApprovalRequestsRef.current.push(request);
      }
      return;
    }

    currentPlanApprovalRequestRef.current = request;
    planApprovalDialogOpenRef.current = true;
    setCurrentPlanApprovalRequest(request);
    setPlanApprovalDialogOpen(true);
  }, []);

  // Process pending plan approval requests queue
  useEffect(() => {
    if (planApprovalDialogOpen) return;
    if (currentPlanApprovalRequest) return;
    const next = pendingPlanApprovalRequestsRef.current.shift();
    if (next) {
      openPlanApprovalDialog(next);
    }
  }, [planApprovalDialogOpen, currentPlanApprovalRequest, openPlanApprovalDialog]);

  // Force-close helpers — invoked by the backend safety-net handlers when the
  // host has already resolved the pending request and we must tear the WebView
  // dialog down. We deliberately do NOT send any response back to the backend.
  const forceCloseAskUserQuestionDialog = useCallback((requestId?: string | null) => {
    const targetId = requestId && requestId.length > 0 ? requestId : null;
    cardDebugLog(`[QCard][webview] forceCloseAskUserQuestionDialog targetId=${targetId}`);
    if (targetId === null) {
      pendingAskUserQuestionRequestsRef.current = [];
      setPendingAskUserQuestionRequests([]);
      currentAskUserQuestionRequestRef.current = null;
      closeQuestionCurrent();
      return;
    }
    pendingAskUserQuestionRequestsRef.current = pendingAskUserQuestionRequestsRef.current.filter(
      (r) => r.requestId !== targetId,
    );
    setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
    if (currentAskUserQuestionRequestRef.current?.requestId === targetId) {
      currentAskUserQuestionRequestRef.current = null;
      setAskUserQuestionDialogOpen(false);
      setCurrentAskUserQuestionRequest(null);
    }
  }, [closeQuestionCurrent]);

  const forceClosePermissionDialog = useCallback((requestId?: string | null) => {
    const targetId = requestId && requestId.length > 0 ? requestId : null;
    cardDebugLog(`[PCard][webview] forceClosePermissionDialog targetId=${targetId}`);
    if (targetId === null) {
      pendingPermissionRequestsRef.current = [];
      setPendingPermissionRequests([]);
      currentPermissionRequestRef.current = null;
      closePermissionCurrent();
      return;
    }
    pendingPermissionRequestsRef.current = pendingPermissionRequestsRef.current.filter(
      (r) => r.channelId !== targetId,
    );
    setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
    if (currentPermissionRequestRef.current?.channelId === targetId) {
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
    }
  }, [closePermissionCurrent]);

  // Permission handlers — send the decision (protocol unchanged) and close the dialog.
  // When the id is not the active dialog it is dropped from the pending queue instead.
  const handlePermissionApprove = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendBridgeEvent('permission_decision', JSON.stringify({
      channelId,
      allow: true,
      remember: false,
      rejectMessage: null,
    }));
    closePermissionCurrent();
  }, [closePermissionCurrent, forceClosePermissionDialog]);

  const handlePermissionApproveAlways = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendBridgeEvent('permission_decision', JSON.stringify({
      channelId,
      allow: true,
      remember: true,
      rejectMessage: null,
    }));
    closePermissionCurrent();
  }, [closePermissionCurrent, forceClosePermissionDialog]);

  const handlePermissionSkip = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendBridgeEvent('permission_decision', JSON.stringify({
      channelId,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    }));
    closePermissionCurrent();
  }, [closePermissionCurrent, t, forceClosePermissionDialog]);

  // AskUserQuestion handlers — send the response (protocol unchanged) and close the dialog.
  // When the id is not the active dialog it is dropped from the pending queue instead.
  const handleAskUserQuestionSubmit = useCallback((requestId: string, answers: Record<string, string | string[]>) => {
    cardDebugLog(`[QCard][webview] submit requestId=${requestId}`, answers);
    if (currentAskUserQuestionRequestRef.current?.requestId !== requestId) {
      forceCloseAskUserQuestionDialog(requestId);
      return;
    }
    sendBridgeEvent('ask_user_question_response', JSON.stringify({ requestId, answers }));
    closeQuestionCurrent();
  }, [closeQuestionCurrent, forceCloseAskUserQuestionDialog]);

  const handleAskUserQuestionSkip = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] skip requestId=${requestId}`);
    if (currentAskUserQuestionRequestRef.current?.requestId !== requestId) {
      forceCloseAskUserQuestionDialog(requestId);
      return;
    }
    sendBridgeEvent('ask_user_question_reject', JSON.stringify({ requestId }));
    closeQuestionCurrent();
  }, [closeQuestionCurrent, forceCloseAskUserQuestionDialog]);

  // (force-close helpers are defined above the handlers)

  // Host-side reply failure (e.g. "Permission request not found" / "Question request
  // not found"): the request was already resolved server-side, so tear the dialog
  // down the same way forceClose does.
  const invalidateQuestionCard = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] invalidateQuestionCard requestId=${requestId}`);
    forceCloseAskUserQuestionDialog(requestId ?? '');
  }, [forceCloseAskUserQuestionDialog]);

  const invalidatePermissionCard = useCallback((channelId: string) => {
    cardDebugLog(`[PCard][webview] invalidatePermissionCard channelId=${channelId}`);
    forceClosePermissionDialog(channelId ?? '');
  }, [forceClosePermissionDialog]);

  // Auto-promote the next pending permission request when the dialog is idle.
  useEffect(() => {
    if (permissionDialogOpen) return;
    if (currentPermissionRequest) return;
    const next = pendingPermissionRequestsRef.current.shift();
    if (next) {
      setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
      currentPermissionRequestRef.current = next;
      setCurrentPermissionRequest(next);
      setPermissionDialogOpen(true);
    }
  }, [permissionDialogOpen, currentPermissionRequest, pendingPermissionRequests]);

  // Auto-promote the next pending ask-user-question request when the dialog is idle.
  useEffect(() => {
    if (askUserQuestionDialogOpen) return;
    if (currentAskUserQuestionRequest) return;
    const next = pendingAskUserQuestionRequestsRef.current.shift();
    if (next) {
      setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
      currentAskUserQuestionRequestRef.current = next;
      setCurrentAskUserQuestionRequest(next);
      setAskUserQuestionDialogOpen(true);
    }
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest, pendingAskUserQuestionRequests]);

  // PlanApproval handlers
  const handlePlanApprovalApprove = useCallback((requestId: string, targetMode: string) => {
    const payload = JSON.stringify({
      requestId,
      approved: true,
      targetMode,
    });
    sendBridgeEvent('plan_approval_response', payload);
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  const handlePlanApprovalReject = useCallback((requestId: string) => {
    const payload = JSON.stringify({
      requestId,
      approved: false,
      targetMode: 'default',
    });
    sendBridgeEvent('plan_approval_response', payload);
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  const forceClosePlanApprovalDialog = useCallback((requestId?: string | null) => {
    const targetId = requestId && requestId.length > 0 ? requestId : null;
    pendingPlanApprovalRequestsRef.current = targetId === null
      ? []
      : pendingPlanApprovalRequestsRef.current.filter((item) => item.requestId !== targetId);
    if (targetId !== null && currentPlanApprovalRequestRef.current?.requestId !== targetId) {
      return;
    }
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  // Context usage dialog handlers
  const isCurrentContextUsageRequest = useCallback((requestId?: string | null) => {
    if (requestId == null || requestId === '') {
      return true;
    }
    return contextUsageRequestIdRef.current === requestId;
  }, []);

  const openContextUsageDialog = useCallback((requestId?: string | null, loading = true) => {
    contextUsageRequestIdRef.current = requestId ?? null;
    setContextUsageData(null);
    setContextUsageIsLoading(loading);
    setContextUsageDialogOpen(true);
  }, []);

  const updateContextUsageData = useCallback((requestId: string | null | undefined, data: ContextUsageData) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    setContextUsageIsLoading(false);
    setContextUsageData(data);
    return true;
  }, [isCurrentContextUsageRequest]);

  const closeContextUsageDialog = useCallback((requestId?: string | null) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    contextUsageRequestIdRef.current = null;
    setContextUsageDialogOpen(false);
    setContextUsageIsLoading(false);
    setContextUsageData(null);
    return true;
  }, [isCurrentContextUsageRequest]);

  return {
    // Permission modal
    permissionDialogOpen,
    currentPermissionRequest,
    pendingPermissionRequests,
    openPermissionDialog,
    handlePermissionApprove,
    handlePermissionApproveAlways,
    handlePermissionSkip,
    forceClosePermissionDialog,

    // AskUserQuestion modal
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    pendingAskUserQuestionRequests,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionSkip,
    forceCloseAskUserQuestionDialog,

    // PlanApproval dialog
    planApprovalDialogOpen,
    currentPlanApprovalRequest,
    openPlanApprovalDialog,
    handlePlanApprovalApprove,
    handlePlanApprovalReject,
    forceClosePlanApprovalDialog,

    // Context usage dialog
    contextUsageDialogOpen,
    contextUsageIsLoading,
    contextUsageData,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,

    // Host reply-failure teardown (delegates to forceClose).
    invalidateQuestionCard,
    invalidatePermissionCard,
  };
}
