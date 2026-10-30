import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { ContextUsageData } from '../components/ContextUsageDialog';
import type { SessionTabData } from '../components/ChatHeader/types';
import { sendHostCommand, sendInterrupt, cardDebugLog } from '../utils/bridge';
import { getTabStore } from '../store/tabStore';
import { removeQuestionAnswerByRequestId } from '../store/questionAnswerStore';
import { isPromptHost, subscribePromptHost } from '../utils/viewIdentity';
import { owningTabIdForSession } from './windowCallbacks/tabTransition';

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

type PromptField = 'pendingPermissions' | 'pendingQuestions' | 'pendingPlans';
type PromptIdKey = 'channelId' | 'requestId';

const EMPTY_REQUESTS: never[] = [];

const promptList = (tab: SessionTabData, field: PromptField): any[] => (
  (tab[field] as any[] | undefined) ?? EMPTY_REQUESTS
);

/**
 * Dialog orchestration for permission / ask-user-question / plan approvals.
 *
 * <p>The tab is the owner. Each tab record already carries
 * `pendingPermissions` / `pendingQuestions` / `pendingPlans`; the dialog layer
 * is a projection of the **active tab's** lists, not a second copy:</p>
 *
 *  - a request for a background tab is written to that tab and only shows when
 *    the tab is selected;
 *  - switching tabs (or leaving the chat page) needs no capture/restore step —
 *    the projection simply reads another tab's (or no) list;
 *  - answering a prompt removes it from the owning tab.
 *
 * <p>`promptHost` still decides which webview instance renders the modal when
 * the same tab is visible in more than one view.</p>
 */
export function useDialogManagement({ t }: UseDialogManagementOptions): UseDialogManagementReturn {
  const store = getTabStore();
  // Only the elected prompt-host view renders interactive dialogs; the other
  // views keep the requests queued and show badges instead of duplicate modals.
  const promptHost = useSyncExternalStore(subscribePromptHost, isPromptHost, isPromptHost);
  const activeTab = useSyncExternalStore(store.subscribe, store.getActiveTab, store.getActiveTab);

  const permissionQueue = promptList(activeTab, 'pendingPermissions') as PermissionRequest[];
  const questionQueue = promptList(activeTab, 'pendingQuestions') as AskUserQuestionRequest[];
  const planQueue = promptList(activeTab, 'pendingPlans') as PlanApprovalRequest[];

  const currentPermissionRequest = promptHost ? (permissionQueue[0] ?? null) : null;
  const currentAskUserQuestionRequest = promptHost ? (questionQueue[0] ?? null) : null;
  const currentPlanApprovalRequest = promptHost ? (planQueue[0] ?? null) : null;

  const pendingPermissionRequests = useMemo(
    () => (promptHost ? permissionQueue.slice(1) : (EMPTY_REQUESTS as PermissionRequest[])),
    [promptHost, permissionQueue],
  );
  const pendingAskUserQuestionRequests = useMemo(
    () => (promptHost ? questionQueue.slice(1) : (EMPTY_REQUESTS as AskUserQuestionRequest[])),
    [promptHost, questionQueue],
  );

  const permissionDialogOpen = currentPermissionRequest !== null;
  const askUserQuestionDialogOpen = currentAskUserQuestionRequest !== null;
  const planApprovalDialogOpen = currentPlanApprovalRequest !== null;

  // Context usage dialog state (a transient panel, not a tab-owned prompt).
  const [contextUsageDialogOpenState, setContextUsageDialogOpenState] = useState(false);
  const [contextUsageIsLoading, setContextUsageIsLoading] = useState(false);
  const [contextUsageData, setContextUsageData] = useState<ContextUsageData | null>(null);
  const contextUsageRequestIdRef = useRef<string | null>(null);

  /** Every tab, including the detached one a window owns before its first tab. */
  const everyTab = useCallback((): SessionTabData[] => {
    const tabs = store.getTabs();
    const active = store.getActiveTab();
    return tabs.some((tab) => tab === active) ? tabs : [...tabs, active];
  }, [store]);

  const findPrompt = useCallback(<T,>(field: PromptField, idKey: PromptIdKey, id: string): T | null => {
    if (!id) return null;
    for (const tab of everyTab()) {
      const hit = promptList(tab, field).find((item) => item?.[idKey] === id);
      if (hit) return hit as T;
    }
    return null;
  }, [everyTab]);

  /** Append to the owning tab (deduped by prompt id). */
  const enqueue = useCallback((field: PromptField, idKey: PromptIdKey, request: any, ownerTabId: string | null) => {
    const id = request?.[idKey];
    if (!id || findPrompt(field, idKey, String(id))) return;
    const append = (tab: SessionTabData): SessionTabData => ({
      ...tab,
      [field]: [...promptList(tab, field), request],
    });
    if (ownerTabId && store.updateTab(ownerTabId, append)) return;
    // The owning tab is not in this window (closed, or the payload had no tab):
    // the prompt must still reach the user, so it lands on the active tab.
    store.updateActiveTab(append);
  }, [findPrompt, store]);

  const removePrompt = useCallback((field: PromptField, idKey: PromptIdKey, id: string) => {
    if (!id) return;
    const owner = everyTab().find((tab) => (
      promptList(tab, field).some((item) => item?.[idKey] === id)
    ));
    if (!owner) return;
    const drop = (tab: SessionTabData): SessionTabData => ({
      ...tab,
      [field]: promptList(tab, field).filter((item) => item?.[idKey] !== id),
    });
    if (owner.id && store.findById(owner.id)) {
      store.updateTab(owner.id, drop);
      return;
    }
    store.updateActiveTab(drop);
  }, [everyTab, store]);

  const clearPrompts = useCallback((field: PromptField) => {
    if (!everyTab().some((tab) => promptList(tab, field).length > 0)) return;
    store.updateAllTabs((tab) => {
      if (promptList(tab, field).length > 0) {
        (tab as any)[field] = [];
      }
    });
    // The window's detached slot (no tab yet) is not part of `tabs`, so the
    // sweep above cannot reach it.
    if (!store.getActiveTabId()) {
      store.updateActiveTab((tab) => (
        promptList(tab, field).length > 0 ? { ...tab, [field]: [] } : tab
      ));
    }
  }, [everyTab, store]);

  const resolveOwnerTab = useCallback((
    request: { tabId?: string | null; sessionId?: string | null },
  ): string => (
    (typeof request.tabId === 'string' && request.tabId)
    || (request.sessionId ? owningTabIdForSession(request.sessionId) : null)
    || store.getActiveTabId()
    || ''
  ), [store]);

  const sendPromptReply = useCallback((
    type: 'question.reply' | 'plan.reply',
    request: { requestId: string; sessionId?: string | null; tabId?: string | null },
    payload: Record<string, unknown>,
  ) => {
    const sessionId = request.sessionId ?? null;
    const ownerTabId = resolveOwnerTab(request);
    if (!ownerTabId && !sessionId) {
      cardDebugLog(`[Prompt][webview] dropping a ${type} without a tab or a session`);
      return;
    }
    sendHostCommand(ownerTabId, type, { requestId: request.requestId, ...payload }, sessionId);
  }, [resolveOwnerTab]);

  const sendPermissionReply = useCallback((
    request: PermissionRequest,
    options: { allow: boolean; remember: boolean; rejectMessage?: string | null },
  ) => {
    const sessionId = request.sessionId ?? null;
    const ownerTabId = resolveOwnerTab(request);
    if (!ownerTabId && !sessionId) {
      cardDebugLog('[PCard][webview] dropping a permission reply without a tab or a session');
      return;
    }
    sendHostCommand(ownerTabId, 'permission.reply', {
      channelId: request.channelId,
      allow: options.allow,
      remember: options.remember,
      rejectMessage: options.rejectMessage ?? null,
    }, sessionId);
  }, [resolveOwnerTab]);

  // ── Permission queue ─────────────────────────────────────────────────────

  const openPermissionDialog = useCallback((request: PermissionRequest) => {
    cardDebugLog(`[PCard][webview] openPermissionDialog channelId=${request.channelId} tabId=${request.tabId ?? ''}`);
    const ownerTabId = request.tabId
      ?? (request.sessionId ? owningTabIdForSession(request.sessionId) : null);
    enqueue('pendingPermissions', 'channelId', request, ownerTabId ?? null);
  }, [enqueue, store]);

  const forceClosePermissionDialog = useCallback((requestId?: string | null) => {
    cardDebugLog(`[PCard][webview] forceClosePermissionDialog targetId=${requestId ?? ''}`);
    if (!requestId) {
      clearPrompts('pendingPermissions');
      return;
    }
    removePrompt('pendingPermissions', 'channelId', requestId);
  }, [clearPrompts, removePrompt]);

  const answerPermission = useCallback((channelId: string, options: {
    allow: boolean;
    remember: boolean;
    rejectMessage?: string | null;
    interrupt?: boolean;
  }) => {
    const request = findPrompt<PermissionRequest>('pendingPermissions', 'channelId', channelId);
    if (!request) return;
    sendPermissionReply(request, options);
    removePrompt('pendingPermissions', 'channelId', channelId);
    if (options.interrupt) {
      sendInterrupt({ tabId: request.tabId ?? null, sessionId: request.sessionId ?? null });
    }
  }, [findPrompt, removePrompt, sendPermissionReply]);

  const handlePermissionApprove = useCallback((channelId: string) => {
    answerPermission(channelId, { allow: true, remember: false, rejectMessage: null });
  }, [answerPermission]);

  const handlePermissionApproveAlways = useCallback((channelId: string) => {
    answerPermission(channelId, { allow: true, remember: true, rejectMessage: null });
  }, [answerPermission]);

  const handlePermissionSkip = useCallback((channelId: string) => {
    answerPermission(channelId, {
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    });
  }, [answerPermission, t]);

  /**
   * 倒计时归零（权限）。
   *
   * 与 Skip 的差别：rejectMessage 用「超时」，并定向中断发起请求的会话——
   * 人已经离开，会话不该带着被拒的结果继续跑。
   */
  const handlePermissionTimeout = useCallback((channelId: string) => {
    cardDebugLog(`[PCard][webview] timeout channelId=${channelId}`);
    answerPermission(channelId, {
      allow: false,
      remember: false,
      rejectMessage: t('permission.timedOut'),
      interrupt: true,
    });
  }, [answerPermission, t]);

  // ── AskUserQuestion queue ────────────────────────────────────────────────

  const openAskUserQuestionDialog = useCallback((request: AskUserQuestionRequest) => {
    cardDebugLog(`[QCard][webview] openAskUserQuestionDialog requestId=${request.requestId} tabId=${request.tabId ?? ''}`);
    const ownerTabId = request.tabId
      ?? (request.sessionId ? owningTabIdForSession(request.sessionId) : null);
    enqueue('pendingQuestions', 'requestId', request, ownerTabId ?? null);
  }, [enqueue, store]);

  const forceCloseAskUserQuestionDialog = useCallback((requestId?: string | null) => {
    cardDebugLog(`[QCard][webview] forceCloseAskUserQuestionDialog targetId=${requestId ?? ''}`);
    if (!requestId) {
      clearPrompts('pendingQuestions');
      return;
    }
    removePrompt('pendingQuestions', 'requestId', requestId);
  }, [clearPrompts, removePrompt]);

  const handleAskUserQuestionSubmit = useCallback((requestId: string, answers: Record<string, string | string[]>) => {
    cardDebugLog(`[QCard][webview] submit requestId=${requestId}`, answers);
    const request = findPrompt<AskUserQuestionRequest>('pendingQuestions', 'requestId', requestId);
    if (!request) return;
    sendPromptReply('question.reply', request, { answers });
    removePrompt('pendingQuestions', 'requestId', requestId);
  }, [findPrompt, removePrompt, sendPromptReply]);

  /**
   * 用户点「取消」（提问）。
   *
   * 与超时一致：先回 `question.reply { rejected: true }`，再定向中断发起提问的
   * 会话。服务端本来就会在 form 被拒后中断这一步（迟到的 "Step interrupted"
   * 属于正常停止），主动中断让宿主侧 `wasAborted` 生效，把那条迟到错误一并
   * 抑制掉——用户已经放弃了这次提问，不该在转录里留下一气泡。
   */
  const handleAskUserQuestionSkip = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] skip requestId=${requestId}`);
    const request = findPrompt<AskUserQuestionRequest>('pendingQuestions', 'requestId', requestId);
    if (!request) return;
    sendPromptReply('question.reply', request, { rejected: true });
    sendInterrupt({ tabId: request.tabId ?? null, sessionId: request.sessionId ?? null });
    removePrompt('pendingQuestions', 'requestId', requestId);
  }, [findPrompt, removePrompt, sendPromptReply]);

  const handleAskUserQuestionTimeout = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] timeout requestId=${requestId}`);
    const request = findPrompt<AskUserQuestionRequest>('pendingQuestions', 'requestId', requestId);
    if (!request) return;
    sendPromptReply('question.reply', request, { rejected: true });
    sendInterrupt({ tabId: request.tabId ?? null, sessionId: request.sessionId ?? null });
    removePrompt('pendingQuestions', 'requestId', requestId);
  }, [findPrompt, removePrompt, sendPromptReply]);

  // ── Plan approval queue ──────────────────────────────────────────────────

  const openPlanApprovalDialog = useCallback((request: PlanApprovalRequest) => {
    const ownerTabId = request.tabId
      ?? (request.sessionId ? owningTabIdForSession(request.sessionId) : null);
    enqueue('pendingPlans', 'requestId', request, ownerTabId ?? null);
  }, [enqueue, store]);

  const forceClosePlanApprovalDialog = useCallback((requestId?: string | null) => {
    if (!requestId) {
      clearPrompts('pendingPlans');
      return;
    }
    removePrompt('pendingPlans', 'requestId', requestId);
  }, [clearPrompts, removePrompt]);

  const handlePlanApprovalApprove = useCallback((requestId: string, targetMode: string) => {
    const request = findPrompt<PlanApprovalRequest>('pendingPlans', 'requestId', requestId);
    if (!request) return;
    sendPromptReply('plan.reply', request, { approved: true, targetMode });
    removePrompt('pendingPlans', 'requestId', requestId);
  }, [findPrompt, removePrompt, sendPromptReply]);

  const handlePlanApprovalReject = useCallback((requestId: string) => {
    const request = findPrompt<PlanApprovalRequest>('pendingPlans', 'requestId', requestId);
    if (!request) return;
    sendPromptReply('plan.reply', request, { approved: false, targetMode: 'default' });
    removePrompt('pendingPlans', 'requestId', requestId);
  }, [findPrompt, removePrompt, sendPromptReply]);

  // ── Context usage dialog ─────────────────────────────────────────────────

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
    setContextUsageDialogOpenState(true);
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
    setContextUsageDialogOpenState(false);
    setContextUsageIsLoading(false);
    setContextUsageData(null);
    return true;
  }, [isCurrentContextUsageRequest]);

  const invalidateQuestionCard = useCallback((requestId: string) => {
    cardDebugLog(`[QCard][webview] invalidateQuestionCard requestId=${requestId}`);
    removeQuestionAnswerByRequestId(requestId ?? '');
    forceCloseAskUserQuestionDialog(requestId ?? '');
  }, [forceCloseAskUserQuestionDialog]);

  const invalidatePermissionCard = useCallback((channelId: string) => {
    cardDebugLog(`[PCard][webview] invalidatePermissionCard channelId=${channelId}`);
    forceClosePermissionDialog(channelId ?? '');
  }, [forceClosePermissionDialog]);

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
    contextUsageDialogOpen: contextUsageDialogOpenState,
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
