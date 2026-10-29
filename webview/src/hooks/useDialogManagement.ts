import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { ContextUsageData } from '../components/ContextUsageDialog';
import { sendHostCommand, sendInterrupt, cardDebugLog } from '../utils/bridge';
import { getTabStore } from '../store/tabStore';
import { removeQuestionAnswerByRequestId } from '../store/questionAnswerStore';
import { useSession } from '../contexts/SessionContext';
import { isPromptHost, subscribePromptHost } from '../utils/viewIdentity';

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
  handlePermissionTimeout: (channelId: string) => void;
  forceClosePermissionDialog: (requestId?: string | null) => void;

  // AskUserQuestion modal (top-level overlay; queue of pending requests)
  askUserQuestionDialogOpen: boolean;
  currentAskUserQuestionRequest: AskUserQuestionRequest | null;
  pendingAskUserQuestionRequests: AskUserQuestionRequest[];
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  handleAskUserQuestionSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  handleAskUserQuestionSkip: (requestId: string) => void;
  handleAskUserQuestionTimeout: (requestId: string) => void;
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
  // Only the elected prompt-host view renders interactive dialogs; the other
  // views keep the requests queued and show badges instead of duplicate modals.
  const promptHost = useSyncExternalStore(subscribePromptHost, isPromptHost, isPromptHost);

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

  /**
   * 把未决弹窗暴露给 tab 层（`useTabLifecycle` 切 tab 时调 `restore`）。
   *
   * 移植自 idea `useDialogManagement.ts` 的同名块。之前本仓只在 `useTabLifecycle`
   * 里调 `window.__dialogStore?.restore(...)`，却没人给它赋值 —— 那条路径一直是
   * 死的，后台 tab 的 prompt 只能靠另建的队列顶着。
   *
   * `restore` 的语义是**整体替换**：切到没有未决请求的 tab 时，这里必须把当前
   * 卡片清掉，否则会把上一个 tab 的权限卡带到新 tab 上。
   */
  useEffect(() => {
    window.__dialogStore = {
      getSnapshot: () => ({
        permissions: currentPermissionRequestRef.current
          ? [currentPermissionRequestRef.current, ...pendingPermissionRequestsRef.current]
          : [...pendingPermissionRequestsRef.current],
        questions: currentAskUserQuestionRequestRef.current
          ? [currentAskUserQuestionRequestRef.current, ...pendingAskUserQuestionRequestsRef.current]
          : [...pendingAskUserQuestionRequestsRef.current],
      }),
      restore: (
        permissions: PermissionRequest[],
        questions: AskUserQuestionRequest[],
        plans: PlanApprovalRequest[] = [],
      ) => {
        const canOpen = isPromptHost();
        if (permissions && permissions.length > 0) {
          if (canOpen) {
            currentPermissionRequestRef.current = permissions[0];
            setCurrentPermissionRequest(permissions[0]);
            pendingPermissionRequestsRef.current = permissions.slice(1);
            setPendingPermissionRequests(permissions.slice(1));
            permissionDialogOpenRef.current = true;
            setPermissionDialogOpen(true);
          } else {
            currentPermissionRequestRef.current = null;
            setCurrentPermissionRequest(null);
            pendingPermissionRequestsRef.current = [...permissions];
            setPendingPermissionRequests([...permissions]);
            permissionDialogOpenRef.current = false;
            setPermissionDialogOpen(false);
          }
        } else {
          currentPermissionRequestRef.current = null;
          setCurrentPermissionRequest(null);
          pendingPermissionRequestsRef.current = [];
          setPendingPermissionRequests([]);
          permissionDialogOpenRef.current = false;
          setPermissionDialogOpen(false);
        }

        if (plans && plans.length > 0) {
          if (canOpen) {
            currentPlanApprovalRequestRef.current = plans[0];
            setCurrentPlanApprovalRequest(plans[0]);
            planApprovalDialogOpenRef.current = true;
            setPlanApprovalDialogOpen(true);
          } else {
            currentPlanApprovalRequestRef.current = null;
            setCurrentPlanApprovalRequest(null);
            pendingPlanApprovalRequestsRef.current = [...plans];
            planApprovalDialogOpenRef.current = false;
            setPlanApprovalDialogOpen(false);
          }
        } else {
          currentPlanApprovalRequestRef.current = null;
          setCurrentPlanApprovalRequest(null);
          planApprovalDialogOpenRef.current = false;
          setPlanApprovalDialogOpen(false);
        }

        if (questions && questions.length > 0) {
          if (canOpen) {
            currentAskUserQuestionRequestRef.current = questions[0];
            setCurrentAskUserQuestionRequest(questions[0]);
            pendingAskUserQuestionRequestsRef.current = questions.slice(1);
            setPendingAskUserQuestionRequests(questions.slice(1));
            askUserQuestionDialogOpenRef.current = true;
            setAskUserQuestionDialogOpen(true);
          } else {
            currentAskUserQuestionRequestRef.current = null;
            setCurrentAskUserQuestionRequest(null);
            pendingAskUserQuestionRequestsRef.current = [...questions];
            setPendingAskUserQuestionRequests([...questions]);
            askUserQuestionDialogOpenRef.current = false;
            setAskUserQuestionDialogOpen(false);
          }
        } else {
          currentAskUserQuestionRequestRef.current = null;
          setCurrentAskUserQuestionRequest(null);
          pendingAskUserQuestionRequestsRef.current = [];
          setPendingAskUserQuestionRequests([]);
          askUserQuestionDialogOpenRef.current = false;
          setAskUserQuestionDialogOpen(false);
        }
      },
      clearActive: () => {
        currentPermissionRequestRef.current = null;
        setCurrentPermissionRequest(null);
        pendingPermissionRequestsRef.current = [];
        setPendingPermissionRequests([]);
        permissionDialogOpenRef.current = false;
        setPermissionDialogOpen(false);

        currentAskUserQuestionRequestRef.current = null;
        setCurrentAskUserQuestionRequest(null);
        pendingAskUserQuestionRequestsRef.current = [];
        setPendingAskUserQuestionRequests([]);
        askUserQuestionDialogOpenRef.current = false;
        setAskUserQuestionDialogOpen(false);
      },
    };
    return () => {
      delete window.__dialogStore;
    };
  }, []);
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
    if (!promptHost || currentPermissionRequestRef.current) {
      pendingPermissionRequestsRef.current.push(request);
      setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
      return;
    }
    currentPermissionRequestRef.current = request;
    setCurrentPermissionRequest(request);
    setPermissionDialogOpen(true);
  }, [promptHost]);

  // Open (or enqueue) an ask-user-question request. Mirrors openPermissionDialog.
  const openAskUserQuestionDialog = useCallback((request: AskUserQuestionRequest) => {
    cardDebugLog(`[QCard][webview] openAskUserQuestionDialog requestId=${request.requestId} toolName="${request.toolName}"`);
    if (currentAskUserQuestionRequestRef.current?.requestId === request.requestId) return;
    if (pendingAskUserQuestionRequestsRef.current.some((r) => r.requestId === request.requestId)) return;
    if (!promptHost || currentAskUserQuestionRequestRef.current) {
      pendingAskUserQuestionRequestsRef.current.push(request);
      setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
      return;
    }
    currentAskUserQuestionRequestRef.current = request;
    setCurrentAskUserQuestionRequest(request);
    setAskUserQuestionDialogOpen(true);
  }, [promptHost]);

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
    if (!promptHost) {
      if (!pendingPlanApprovalRequestsRef.current.some((item) => item.requestId === request.requestId)) {
        pendingPlanApprovalRequestsRef.current.push(request);
      }
      return;
    }

    currentPlanApprovalRequestRef.current = request;
    planApprovalDialogOpenRef.current = true;
    setCurrentPlanApprovalRequest(request);
    setPlanApprovalDialogOpen(true);
  }, [promptHost]);

  // Process pending plan approval requests queue
  useEffect(() => {
    if (!promptHost) return;
    if (planApprovalDialogOpen) return;
    if (currentPlanApprovalRequest) return;
    const next = pendingPlanApprovalRequestsRef.current.shift();
    if (next) {
      openPlanApprovalDialog(next);
    }
  }, [promptHost, planApprovalDialogOpen, currentPlanApprovalRequest, openPlanApprovalDialog]);

  // Prompt-host election changed: the losing view closes its modal and puts
  // the request back into its queue. The promotion itself is handled by the
  // auto-promote effects below, which now also depend on `promptHost`.
  useEffect(() => {
    if (promptHost) {
      return;
    }
    const activePermission = currentPermissionRequestRef.current;
    if (activePermission) {
      pendingPermissionRequestsRef.current = [
        activePermission,
        ...pendingPermissionRequestsRef.current,
      ];
      setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
      currentPermissionRequestRef.current = null;
      setCurrentPermissionRequest(null);
      setPermissionDialogOpen(false);
    }
    const activeQuestion = currentAskUserQuestionRequestRef.current;
    if (activeQuestion) {
      pendingAskUserQuestionRequestsRef.current = [
        activeQuestion,
        ...pendingAskUserQuestionRequestsRef.current,
      ];
      setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
      currentAskUserQuestionRequestRef.current = null;
      setCurrentAskUserQuestionRequest(null);
      setAskUserQuestionDialogOpen(false);
    }
    const activePlan = currentPlanApprovalRequestRef.current;
    if (activePlan) {
      pendingPlanApprovalRequestsRef.current = [
        activePlan,
        ...pendingPlanApprovalRequestsRef.current,
      ];
      currentPlanApprovalRequestRef.current = null;
      setCurrentPlanApprovalRequest(null);
      setPlanApprovalDialogOpen(false);
    }
  }, [promptHost]);

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
  /**
   * v2 prompt replies. The owner tab/session travel with the command so a
   * late answer from a stale dialog cannot land on whichever tab is active.
   */
  const sendPromptReply = (
    type: 'question.reply' | 'plan.reply',
    requestId: string,
    payload: Record<string, unknown>,
    sessionId?: string | null,
    tabId?: string | null,
  ) => {
    const ownerTabId = tabId
      ?? (sessionId ? getTabStore().findIdBySession(sessionId) : null)
      ?? getTabStore().getActiveTabId()
      ?? '';
    if (!ownerTabId && !sessionId) {
      cardDebugLog(`[Prompt][webview] dropping a ${type} without a tab or a session`);
      return;
    }
    sendHostCommand(ownerTabId, type, { requestId, ...payload }, sessionId ?? null);
  };

  const sendPermissionReply = (options: {
    channelId: string;
    sessionId?: string | null;
    tabId?: string | null;
    allow: boolean;
    remember: boolean;
    rejectMessage?: string | null;
  }) => {
    const active = currentPermissionRequestRef.current;
    const sessionId = options.sessionId ?? active?.sessionId ?? null;
    const ownerTabId = options.tabId ?? active?.tabId
      ?? (sessionId ? getTabStore().findIdBySession(sessionId) : null)
      ?? getTabStore().getActiveTabId()
      ?? '';
    if (!ownerTabId && !sessionId) {
      cardDebugLog('[PCard][webview] dropping a permission reply without a tab or a session');
      return;
    }
    sendHostCommand(ownerTabId, 'permission.reply', {
      channelId: options.channelId,
      allow: options.allow,
      remember: options.remember,
      rejectMessage: options.rejectMessage ?? null,
    }, sessionId);
  };

  const handlePermissionApprove = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendPermissionReply({
      channelId,
      allow: true,
      remember: false,
      rejectMessage: null,
    });
    closePermissionCurrent();
  }, [closePermissionCurrent, forceClosePermissionDialog]);

  const handlePermissionApproveAlways = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendPermissionReply({
      channelId,
      allow: true,
      remember: true,
      rejectMessage: null,
    });
    closePermissionCurrent();
  }, [closePermissionCurrent, forceClosePermissionDialog]);

  const handlePermissionSkip = useCallback((channelId: string) => {
    if (currentPermissionRequestRef.current?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    sendPermissionReply({
      channelId,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    });
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
    const active = currentAskUserQuestionRequestRef.current;
    sendPromptReply('question.reply', requestId, { answers }, active?.sessionId, active?.tabId);
    closeQuestionCurrent();
  }, [closeQuestionCurrent, forceCloseAskUserQuestionDialog]);

  const handleAskUserQuestionSkip = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] skip requestId=${requestId}`);
    if (currentAskUserQuestionRequestRef.current?.requestId !== requestId) {
      forceCloseAskUserQuestionDialog(requestId);
      return;
    }
    const active = currentAskUserQuestionRequestRef.current;
    sendPromptReply('question.reply', requestId, { rejected: true }, active?.sessionId, active?.tabId);
    closeQuestionCurrent();
  }, [closeQuestionCurrent, forceCloseAskUserQuestionDialog]);

  /**
   * 倒计时归零（权限）。
   *
   * 与 handlePermissionSkip 的差别有两点，但都是必要的：
   *  1) rejectMessage 用「超时」而不是「用户拒绝」——服务端与日志要能区分；
   *  2) 额外中断发起请求的那个会话。人已经离开，会话不该带着被拒的结果继续跑；
   *     中断按 sessionId 定向（宿主盖章），不是「当前活跃会话」。
   */
  const handlePermissionTimeout = useCallback((channelId: string) => {
    cardDebugLog(`[PCard][webview] timeout channelId=${channelId}`);
    const activeReq = currentPermissionRequestRef.current;
    if (activeReq?.channelId !== channelId) {
      forceClosePermissionDialog(channelId);
      return;
    }
    const sessionId = activeReq.sessionId ?? null;
    sendPermissionReply({
      channelId,
      sessionId,
      tabId: activeReq.tabId,
      allow: false,
      remember: false,
      rejectMessage: t('permission.timedOut'),
    });
    sendInterrupt({ tabId: activeReq.tabId ?? null, sessionId });
    closePermissionCurrent();
  }, [closePermissionCurrent, t, forceClosePermissionDialog]);

  /** 倒计时归零（提问）：同上。 */
  const handleAskUserQuestionTimeout = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] timeout requestId=${requestId}`);
    const activeReq = currentAskUserQuestionRequestRef.current;
    if (activeReq?.requestId !== requestId) {
      forceCloseAskUserQuestionDialog(requestId);
      return;
    }
    const sessionId = activeReq.sessionId ?? null;
    sendPromptReply('question.reply', requestId, { rejected: true }, sessionId, activeReq.tabId);
    sendInterrupt({ tabId: activeReq.tabId ?? null, sessionId });
    closeQuestionCurrent();
  }, [closeQuestionCurrent, forceCloseAskUserQuestionDialog]);

  // (force-close helpers are defined above the handlers)

  // Host-side reply failure (e.g. "Permission request not found" / "Question request
  // not found"): the request was already resolved server-side, so tear the dialog
  // down the same way forceClose does.
  const invalidateQuestionCard = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] invalidateQuestionCard requestId=${requestId}`);
    // 宿主编排已判定这张卡失效：答案也要从 store 里摘掉，否则消息流里会留下
    // 一张永远等不到答复的「已作答」卡（idea 同款处理）。
    removeQuestionAnswerByRequestId(requestId ?? '');
    forceCloseAskUserQuestionDialog(requestId ?? '');
  }, [forceCloseAskUserQuestionDialog]);

  const invalidatePermissionCard = useCallback((channelId: string) => {
    cardDebugLog(`[PCard][webview] invalidatePermissionCard channelId=${channelId}`);
    forceClosePermissionDialog(channelId ?? '');
  }, [forceClosePermissionDialog]);

  // Auto-promote the next pending permission request when the dialog is idle.
  useEffect(() => {
    if (!promptHost) return;
    if (permissionDialogOpen) return;
    if (currentPermissionRequest) return;
    const next = pendingPermissionRequestsRef.current.shift();
    if (next) {
      setPendingPermissionRequests([...pendingPermissionRequestsRef.current]);
      currentPermissionRequestRef.current = next;
      setCurrentPermissionRequest(next);
      setPermissionDialogOpen(true);
    }
  }, [promptHost, permissionDialogOpen, currentPermissionRequest, pendingPermissionRequests]);

  // Auto-promote the next pending ask-user-question request when the dialog is idle.
  useEffect(() => {
    if (!promptHost) return;
    if (askUserQuestionDialogOpen) return;
    if (currentAskUserQuestionRequest) return;
    const next = pendingAskUserQuestionRequestsRef.current.shift();
    if (next) {
      setPendingAskUserQuestionRequests([...pendingAskUserQuestionRequestsRef.current]);
      currentAskUserQuestionRequestRef.current = next;
      setCurrentAskUserQuestionRequest(next);
      setAskUserQuestionDialogOpen(true);
    }
  }, [promptHost, askUserQuestionDialogOpen, currentAskUserQuestionRequest, pendingAskUserQuestionRequests]);

  // PlanApproval handlers
  const handlePlanApprovalApprove = useCallback((requestId: string, targetMode: string) => {
    sendPromptReply('plan.reply', requestId, { approved: true, targetMode });
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  const handlePlanApprovalReject = useCallback((requestId: string) => {
    sendPromptReply('plan.reply', requestId, { approved: false, targetMode: 'default' });
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
    handlePermissionTimeout,
    forceClosePermissionDialog,

    // AskUserQuestion modal
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    pendingAskUserQuestionRequests,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionSkip,
    handleAskUserQuestionTimeout,
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
