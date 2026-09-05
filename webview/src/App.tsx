import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import { sendBridgeEvent } from './utils/bridge';
import { copyViaHost } from './utils/copyUtils';
import { preloadSlashCommands } from './components/ChatInputBox/providers';
import {
  useScrollBehavior,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useHistoryLoader,
  useMessageQueue,
  useThemeInit,
  useContextActions,
  useMessageProcessing,
  useMessageSender,
  useModelProviderState,
  useChatComputations,
  useCompactConfirm,
} from './hooks';
import {
  NEW_SESSION_COMMANDS,
  RESUME_COMMANDS,
  PLAN_COMMANDS,
  CONTEXT_COMMANDS,
  BUILTIN_SESSION_COMMANDS,
} from './hooks/useMessageSender';
import { applyDiffTheme, getStoredDiffTheme } from './utils/diffTheme';
import { collectTaskEventsFromMessages } from './utils/taskNotificationMessage';
import { createCompactSuccessNotice, createCompactFailureNotice } from './utils/messageUtils';
import type { ClaudeMessage } from './types';
import type { Attachment, ChatInputBoxHandle } from './components/ChatInputBox/types';
import { ToastContainer } from './components/Toast';
import { ChatHeader } from './components/ChatHeader';
import { ChatScreen } from './components/ChatScreen';
import type { MessageListRevealHandle } from './components/ConversationSearch/types';
import { useSubagentContextValues, useSetTaskEvents } from './contexts/SubagentContext';
import { useMessages } from './contexts/MessagesContext';
import { useSession } from './contexts/SessionContext';
import { useUIState } from './contexts/UIStateContext';
import { useDialogs } from './contexts/DialogContext';
import { AppDialogs } from './components/AppDialogs';
import ConfirmDialog from './components/ConfirmDialog';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from './utils/permissionDialogTimeout';

const App = () => {
  const { t } = useTranslation();

  // ── Dialog management (extracted to DialogContext, stage 4 of TASK-P1-01) ──
  // Open* / set* are still needed by hooks (useWindowCallbacks).
  // Display state (permissionDialogOpen / askUserQuestionDialogOpen / etc.) is
  // consumed directly inside <AppDialogs> via useDialogs().
  const {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    invalidateQuestionCard,
    invalidatePermissionCard,
    forceClosePlanApprovalDialog,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,
  } = useDialogs();

  // ── Messages flow state (extracted to MessagesContext, stage 1 of TASK-P1-01) ──
  // Display state (loadingStartTime / isThinking) is consumed inside <ChatScreen>.
  const {
    messages, setMessages,
    subagentHistories, setSubagentHistories,
    setStatus,
    loading, setLoading, setLoadingStartTime,
    setIsThinking,
    streamingActive, setStreamingActive,
    setSessionLoading,
    setSseTodos,
    sseTodos,
    isCompacting, setIsCompacting,
    setCompactingStartTime,
  } = useMessages();

  // task_events live in TaskEventProvider (SubagentContext) so their updates do
  // not re-render every MessagesContext consumer.
  const setTaskEvents = useSetTaskEvents();

  // ── Session state (extracted to SessionContext, stage 2 of TASK-P1-01) ──
  const {
    currentSessionId, setCurrentSessionId,
    customSessionTitle, setCustomSessionTitle,
    historyData, setHistoryData,
    currentSessionIdRef, customSessionTitleRef,
  } = useSession();

  // ── UI state (extracted to UIStateContext, stage 3 of TASK-P1-01) ──
  // Dialog visibility (addModelDialog / changelog) is consumed inside AppDialogs.
  const {
    currentView, setCurrentView,
    settingsInitialTab, setSettingsInitialTab,
    toasts, addToast, dismissToast, clearToasts,
    setContextInfo,
    searchOpen, setSearchOpen,
  } = useUIState();

  // ── Permission dialog timeout (synced with backend config) ──
  const [permissionDialogTimeoutSeconds, setPermissionDialogTimeoutSeconds] = useState(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);

  // ── Local refs (don't trigger re-render, kept in App.tsx) ──
  const isFirstMountRef = useRef(true);
  const chatInputRef = useRef<ChatInputBoxHandle>(null);

  // StatusPanel collapse state — kept in App.tsx because forceStatusUpdate is
  // intentionally local: a tiny re-render trigger paired with userCollapsedRef.
  const userCollapsedRef = useRef(false);
  const [, forceStatusUpdate] = useState(0);

  // Message anchor node registry for anchor rail navigation
  const messageNodeMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [anchorCollapsedCount, setAnchorCollapsedCount] = useState(0);
  const handleMessageNodeRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) { messageNodeMapRef.current.set(id, node); }
    else { messageNodeMapRef.current.delete(id); }
  }, []);

  // Imperative handle for the in-page search panel to expand collapsed earlier messages.
  const messageListRef = useRef<MessageListRevealHandle | null>(null);

  // ── Theme & context actions ──
  useThemeInit();
  useContextActions();

  // Apply diff theme on app startup so diff styles work before opening Settings.
  useEffect(() => {
    const ideTheme = window.__INITIAL_IDE_THEME__ ?? null;
    applyDiffTheme(getStoredDiffTheme(), ideTheme);
  }, []);

  // ── Scroll behavior ──
  const {
    messagesContainerRef, messagesEndRef, inputAreaRef,
    isUserAtBottomRef, isAutoScrollingRef, userPausedRef, scrollToBottom,
  } = useScrollBehavior({ currentView, messages, loading, streamingActive });

  // ── Streaming messages ──
  const {
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    streamingMessageIndexRef, contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    lastContentUpdateRef, lastThinkingUpdateRef, autoExpandedThinkingKeysRef,
    streamingTurnIdRef, turnIdCounterRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
  } = useStreamingMessages();

  // (Toast helpers moved to UIStateContext)

  // ── Model/Provider state ──
  const {
    currentProvider, selectedModel, permissionMode,
    daemonStatusLoaded, retryDaemonStatus, currentSdkInstalled,
    currentProviderRef,
    activeProviderConfig, claudeSettingsAlwaysThinkingEnabled,
    reasoningEffort, codexFastMode, sendShortcut, autoOpenFileEnabled,
    longContextEnabled,
    usagePercentage, usageUsedTokens, usageMaxTokens,
    setPermissionMode, setCurrentProvider,
    setClaudePermissionMode, setCodexPermissionMode, setOpenCodePermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setSelectedOpenCodeModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setSendShortcut, setAutoOpenFileEnabled,
    setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    syncActiveProviderModelMapping,
    handleModeSelect, handleModelSelect, handleProviderSelect,
    handleReasoningChange, handleCodexFastModeChange, handleToggleThinking,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange, handleLongContextChange,
  } = useModelProviderState({ addToast, t });

  // ── Global drag event interception ──
  useEffect(() => {
    const preventExternalDrop = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      const isExternalDrop = types.includes('Files') || types.includes('text/uri-list');
      if (!isExternalDrop) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', preventExternalDrop);
    document.addEventListener('drop', preventExternalDrop);
    document.addEventListener('dragenter', preventExternalDrop);
    return () => {
      document.removeEventListener('dragover', preventExternalDrop);
      document.removeEventListener('drop', preventExternalDrop);
      document.removeEventListener('dragenter', preventExternalDrop);
    };
  }, []);

  // ── Close in-conversation search panel when navigating away from chat ──
  // Split from the hotkey effect below so that toggling `searchOpen` does
  // NOT rebind the global keydown listener every time the panel opens/closes.
  useEffect(() => {
    if (currentView !== 'chat' && searchOpen) {
      setSearchOpen(false);
    }
  }, [currentView, searchOpen, setSearchOpen]);

  // ── In-conversation search hotkey (Cmd+F on macOS, Ctrl+F elsewhere) ──
  // Only active in chat view. Settings / history use their own search
  // (HistoryFilters) or none at all — we deliberately let the platform
  // handle Cmd+F there.
  //
  // We deliberately listen for ONLY the platform-appropriate modifier:
  // macOS users use Ctrl+F as the Emacs-style "forward-char" cursor move,
  // so we MUST NOT capture Ctrl+F on macOS. This is a real regression
  // surfaced by code review.
  //
  // Platform detection prefers `navigator.userAgentData.platform` (modern,
  // non-deprecated) and falls back to `userAgent` string sniffing for
  // JCEF / older Chromium where userAgentData may be unavailable.
  // `navigator.platform` is intentionally NOT used — it is deprecated and
  // returns inconsistent values inside JCEF.
  useEffect(() => {
    if (currentView !== 'chat') return;
    const isMac = (() => {
      if (typeof navigator === 'undefined') return false;
      const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
      }).userAgentData;
      const platform = uaData?.platform ?? navigator.userAgent ?? '';
      return /mac|iphone|ipad|ipod/i.test(platform);
    })();
    const handler = (e: KeyboardEvent) => {
      const key = e.key;
      if (key !== 'f' && key !== 'F') return;
      const isFind = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
      if (!isFind) return;
      // Don't fight IME composition.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
    // setSearchOpen is a stable useState setter; intentionally omitted from
    // deps so we don't rebind the global listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  // ── Slash command preloading ──
  useEffect(() => {
    preloadSlashCommands();
  }, []);

  useEffect(() => {
    if (isFirstMountRef.current) { isFirstMountRef.current = false; return; }
  }, [currentView]);

  // Recover task events from task-notification user messages. Recent Claude Code
  // delivers a background agent's terminal report as a plain user message (XML
  // in content) instead of an SDK task_notification event, so history replay —
  // and any live session that never fired the SDK path — would otherwise leave
  // the subagent card stuck on the launch ack text. Derived entries only fill
  // gaps: a real SDK event already in the map is kept as-is.
  // Messages update immutably, so unchanged messages keep their object identity;
  // tracking scanned objects avoids re-scanning the whole conversation on every
  // streaming chunk.
  const scannedTaskNotificationMessagesRef = useRef(new WeakSet<ClaudeMessage>());
  useEffect(() => {
    const scanned = scannedTaskNotificationMessagesRef.current;
    const fresh = messages.filter((m) => !scanned.has(m));
    if (fresh.length === 0) return;
    for (const m of fresh) scanned.add(m);
    const derived = collectTaskEventsFromMessages(fresh);
    if (Object.keys(derived).length === 0) return;
    setTaskEvents((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, event] of Object.entries(derived)) {
        if (next[id]) continue;
        next[id] = event;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages, setTaskEvents]);

  // ── Session management ──
  const {
    showNewSessionConfirm, showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession, forceCreateNewSession,
    forceCreateNewSessionWithProvider,
    handleConfirmNewSession, handleCancelNewSession,
    handleConfirmInterrupt, handleCancelInterrupt,
    loadHistorySession, deleteHistorySession, deleteHistorySessions, exportHistorySession,
    toggleFavoriteSession, updateHistoryTitle, applyHistoryTitleLocal, convertToCliSession,
  } = useSessionManagement({
    messages, loading, historyData, currentSessionId, currentSessionIdRef, currentProvider,
    setHistoryData, setMessages, setCurrentView, setCurrentSessionId,
    setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setStatus, setLoading, setIsThinking, setStreamingActive, setSessionLoading,
    setTaskEvents,
    setSseTodos,
    setSubagentHistories,
    clearToasts, addToast, t,
  });

  useHistoryLoader({ currentView, currentProvider });

  // ── Share state ──
  const [isShared, setIsShared] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  /** Set once the server reports sharing is disabled ("share": "disabled") — hides the header controls. */
  const [shareHidden, setShareHidden] = useState(false);

  const resetShareState = useCallback(() => {
    setIsShared(false);
    setSharePending(false);
    setShareUrl(null);
    setShareHidden(false);
  }, []);

  const handleShare = useCallback(async () => {
    if (!currentSessionId || sharePending || shareHidden) return;
    // No premature success toast here: the share URL only becomes copyable
    // when the host round-trips onShareSuccess. Feedback happens there.
    setSharePending(true);
    sendBridgeEvent('share_session', currentSessionId);
  }, [currentSessionId, sharePending, shareHidden]);

  const handleUnshare = useCallback(async () => {
    if (!currentSessionId) return;
    sendBridgeEvent('unshare_session', currentSessionId);
    setIsShared(false);
    setShareUrl(null);
  }, [currentSessionId]);

  const handleCopyShareLink = useCallback(() => {
    if (!shareUrl) {
      // Link unknown (e.g. page reloaded) — re-create the share instead.
      void handleShare();
      return;
    }
    void copyViaHost(shareUrl).then((ok) => {
      addToast(ok ? t('chat.shareSuccess') : t('chat.shareFailed'), ok ? 'success' : 'error');
    });
  }, [shareUrl, handleShare, addToast, t]);

  // ── Undo/Redo state ──
  /** opencode message id of the revert boundary (drives RevertPlaceholderBar). */
  const [revertBoundaryId, setRevertBoundaryId] = useState<string | null>(null);
  const hasRevertStateRef = useRef(false);
  const revertBoundaryIdRef = useRef<string | null>(null);

  /**
   * 同步更新 revert 状态的 ref 与 boundary（ref 供回调内做变更检测，避开闭包旧值）。
   * messageId 是服务端 revert 指针指向的用户消息 id，占位条据此定位切片。
   */
  const applyRevertState = useCallback((next: boolean, messageId?: string | null) => {
    hasRevertStateRef.current = next;
    revertBoundaryIdRef.current = next ? (messageId ?? null) : null;
    setRevertBoundaryId(next ? (messageId ?? null) : null);
  }, []);

  /**
   * Resolve an opencode message id from a chat message. Live messages may
   * carry it top-level or inside raw.id / raw.uuid; history-restored messages
   * always have raw.id (see SdkMessageConverter). Returns undefined when the
   * caller should fall back to the backend's latest-user-message resolution.
   */
  const getMessageId = useCallback((message: ClaudeMessage | null | undefined): string | undefined => {
    if (!message) return undefined;
    if (typeof message.id === 'string' && message.id) return message.id;
    const raw = message.raw as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      if (typeof raw.id === 'string' && raw.id) return raw.id;
      if (typeof raw.uuid === 'string' && raw.uuid) return raw.uuid;
    }
    return undefined;
  }, []);

  /**
   * Send the revert/unrevert bridge event. Caller must have settled any
   * busy-session confirmation beforehand (see pendingRevert flow).
   */
  const dispatchRevert = useCallback((message: ClaudeMessage) => {
    const id = getMessageId(message);
    if (!id) {
      // live 消息尚未回填 opencode id —— 让宿主通过 listMessages 解析最后一条用户消息
      console.warn('[App] undo: message has no id; falling back to backend latest-user resolution');
      sendBridgeEvent('revert_session', 'latest');
      applyRevertState(true);
      return;
    }
    console.debug('[App] undo: reverting to message', id);
    sendBridgeEvent('revert_session', id);
    // Optimistic: boundary is the undone user message; the host's
    // onRevertStateUpdate push carries the authoritative pointer.
    applyRevertState(true, id);
  }, [applyRevertState, getMessageId]);

  /** Pending "interrupt then undo/redo" confirmation (busy session). */
  const [pendingRevert, setPendingRevert] = useState<
    { op: 'undo'; target: ClaudeMessage } | { op: 'redo' } | null
  >(null);

  const handleUndoMessage = useCallback((message: ClaudeMessage) => {
    if (streamingActive) {
      // 运行中撤销：先确认中断（服务端 revert 在 session busy 时会被拒绝）
      setPendingRevert({ op: 'undo', target: message });
      return;
    }
    dispatchRevert(message);
  }, [dispatchRevert, streamingActive]);

  const handleRedoMessage = useCallback(() => {
    if (streamingActive) {
      setPendingRevert({ op: 'redo' });
      return;
    }
    sendBridgeEvent('unrevert_session');
    applyRevertState(false);
  }, [applyRevertState, streamingActive]);

  // Confirm/cancel handlers live below, after `interruptSession` (useMessageSender)
  // exists — see handleConfirmInterruptRevert.

  const handleForkRequest = useCallback((message: ClaudeMessage) => {
    if (streamingActive) {
      addToast(t('chat.forkDisabledTooltip'), 'warning');
      return;
    }
    const id = getMessageId(message);
    if (!id) {
      console.warn('[App] fork: message has no id; falling back to backend latest-user resolution');
      sendBridgeEvent('fork_session', 'latest');
      return;
    }
    sendBridgeEvent('fork_session', id);
  }, [streamingActive, addToast, t, getMessageId]);

  /** 全量 fork（Header 按钮 + 斜杠 /fork）：复制整个会话，不带 messageID。 */
  const handleForkFull = useCallback(() => {
    if (streamingActive) {
      addToast(t('chat.forkDisabledTooltip'), 'warning');
      return;
    }
    sendBridgeEvent('fork_session', 'full');
  }, [streamingActive, addToast, t]);

  // Latest user message id, used by the builtin /undo slash command.
  const findLatestUserMessageId = useCallback((): string | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== 'user') continue;
      const id = getMessageId(m);
      if (id) return id;
    }
    return undefined;
  }, [messages, getMessageId]);

  // Register bridge callbacks for share / fork / revert / compact results
  useEffect(() => {
    window.onForkSuccess = (json: string) => {
      try {
        const payload = JSON.parse(json) as { sessionId?: string };
        console.debug('[App] onForkSuccess', payload);
        const newSessionId = payload.sessionId;
        if (!newSessionId) return;
        // Fork result toast with an explicit switch action; default is to stay
        // in the current session when the toast times out.
        addToast(t('chat.forkCreatedToast'), 'info', {
          label: t('chat.forkSwitchAction'),
          onClick: () => loadHistorySession(newSessionId),
        }, { duration: 5000 });
      } catch {
        // ignore malformed payloads
      }
    };
    window.onForkError = (detail?: string) => {
      console.warn('[App] onForkError', detail);
      addToast(`${t('chat.forkFailed')}${detail ? `: ${detail}` : ''}`, 'error');
    };
    window.onShareSuccess = (url: string) => {
      console.debug('[App] onShareSuccess, copying url to clipboard');
      setSharePending(false);
      setIsShared(true);
      setShareUrl(url);
      void copyViaHost(url).then((ok) => {
        if (ok) {
          addToast(t('chat.shareSuccess'), 'success');
        } else {
          // 剪贴板写入失败 ≠ 分享失败：链接已在服务端创建，
          // 提供重试入口而不是误导性的「分享未完成」。
          addToast(t('chat.shareLinkCreated'), 'info', {
            label: t('chat.retryCopy'),
            onClick: () => {
              void copyViaHost(url).then((retryOk) => {
                addToast(retryOk ? t('chat.shareSuccess') : t('chat.shareFailed'), retryOk ? 'success' : 'error');
              });
            },
          }, { duration: 5000 });
        }
      });
    };
    window.onShareError = (detail?: string) => {
      console.warn('[App] onShareError', detail);
      setSharePending(false);
      setIsShared(false);
      const reason = (detail ?? '').trim();
      // opencode 在 share 功能被关闭（opencode.json "share": "disabled"）时，
      // 服务端对 share 接口返回 500 InternalServerError —— 映射为可操作的提示。
      if (/InternalServerError|UnknownError/i.test(reason)) {
        setShareHidden(true);
        addToast(`${t('chat.shareFailed')} — ${t('chat.shareDisabledHint')}`, 'error');
        return;
      }
      addToast(reason ? `${t('chat.shareFailed')}: ${reason}` : t('chat.shareFailed'), 'error');
    };
    window.onRevertError = (json: string) => {
      let op = 'undo';
      try {
        op = (JSON.parse(json) as { op?: string }).op ?? 'undo';
      } catch {
        // keep default
      }
      addToast(op === 'undo' ? t('chat.revertFailed') : t('chat.restoreFailed'), 'error');
      // 清除乐观撤销边界，避免重载前占位条还在、而底层消息却已恢复的矛盾状态。
      applyRevertState(false);
      // 回滚乐观状态：重载会话让宿主推送真实的 revert 指针与消息列表
      const sessionId = currentSessionIdRef.current;
      if (sessionId) {
        loadHistorySession(sessionId);
      }
    };
    window.onRevertStateUpdate = (json: string) => {
      try {
        const payload = JSON.parse(json) as { hasRevert?: boolean; messageId?: string | null };
        console.debug('[App] onRevertStateUpdate', payload);
        const next = !!payload.hasRevert;
        const nextId = payload.messageId ?? null;
        // 重载触发条件：hasRevert 变化「或」边界消息 id 变化。
        // 仅比较 hasRevert 会在「已有撤销态时再次点击撤销」场景下漏掉重载：
        // 此时 hasRevert 仍为 true（changed=false），但边界 msg_xxx 已改变，
        // 新边界消息未被拉取进前端 → messageMatchesId 命中失败 → 消息不折叠、
        // 占位条为空且「展示」无反应。
        const changed = next !== hasRevertStateRef.current || nextId !== revertBoundaryIdRef.current;
        applyRevertState(next, nextId);
        // Reload the transcript so reverted/restored messages are reflected.
        // 仅在状态真正变化时重载：宿主在每次历史加载完成后都会推送本事件，
        // 无条件重载会形成 load_session → onRevertStateUpdate → load_session
        // 的死循环，表现为消息列表持续闪烁。
        if (changed) {
          const sessionId = currentSessionIdRef.current;
          if (sessionId) {
            loadHistorySession(sessionId);
          }
        }
      } catch {
        // ignore malformed payloads
      }
    };
    window.onCompactSuccess = () => {
      setIsCompacting(false);
      setCompactingStartTime(null);
      setMessages((prev) => [...prev, createCompactSuccessNotice(t('chat.compactSuccess'))]);
      // Force scroll to bottom after compact completes
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    };
    window.onCompactError = (detail?: string) => {
      setIsCompacting(false);
      setCompactingStartTime(null);
      setMessages((prev) => [...prev, createCompactFailureNotice(t('chat.compactFailed'), detail)]);
    };
    return () => {
      delete window.onForkSuccess;
      delete window.onForkError;
      delete window.onShareSuccess;
      delete window.onShareError;
      delete window.onRevertError;
      delete window.onRevertStateUpdate;
      delete window.onCompactSuccess;
      delete window.onCompactError;
    };
  }, [applyRevertState, loadHistorySession, currentSessionIdRef, addToast, t, setMessages, setIsCompacting, setCompactingStartTime, scrollToBottom]);

  // ── Window callbacks (bridge communication) ──
  useWindowCallbacks({
    t, addToast, clearToasts,
    setMessages, setStatus, setLoading, setLoadingStartTime,
    setIsThinking, setStreamingActive, setSessionLoading, setHistoryData,
    setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setPermissionMode, setCurrentProvider, setClaudePermissionMode, setCodexPermissionMode,
    setOpenCodePermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel, setSelectedOpenCodeModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setSendShortcut, setAutoOpenFileEnabled,
    setContextInfo,
    setSubagentHistories,
    setTaskEvents,
    setSseTodos,
    currentProviderRef, messagesContainerRef, isUserAtBottomRef, userPausedRef,
    suppressNextStatusToastRef,
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef, turnIdCounterRef,
    lastContentUpdateRef, contentUpdateTimeoutRef,
    lastThinkingUpdateRef, thinkingUpdateTimeoutRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog, openAskUserQuestionDialog, openPlanApprovalDialog,
    forceClosePermissionDialog, forceCloseAskUserQuestionDialog, invalidateQuestionCard, invalidatePermissionCard, forceClosePlanApprovalDialog,
    openContextUsageDialog, updateContextUsageData,
    closeContextUsageDialog,
    customSessionTitleRef, currentSessionIdRef, updateHistoryTitle, applyHistoryTitleLocal,
    setCustomSessionTitle,
    setPermissionDialogTimeoutSeconds,
  });

  // ── Message processing ──
  const {
    getMessageText, getContentBlocks,
    mergedMessages, sentAttachmentsRef,
  } = useMessageProcessing({ messages, currentSessionId, t });

  // ── Message sender ──
  // Wrap handleProviderSelect to also clear messages and input (like creating a new session)
  const wrappedHandleProviderSelect = useCallback((providerId: string) => {
    chatInputRef.current?.clear();
    handleProviderSelect(providerId);
    forceCreateNewSessionWithProvider(providerId);
  }, [forceCreateNewSessionWithProvider, handleProviderSelect]);

  const {
    handleSubmit: hookHandleSubmit,
    executeMessage,
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, selectedModel, permissionMode, reasoningEffort, codexFastMode,
    daemonStatusLoaded, currentSdkInstalled,
    sentAttachmentsRef, chatInputRef, messagesContainerRef,
    isUserAtBottomRef, userPausedRef, isStreamingRef,
    setMessages, setLoading, setLoadingStartTime, setStreamingActive,
    setCurrentView,
    forceCreateNewSession,
    handleModeSelect,
    longContextEnabled,
    openContextUsageDialog,
    closeContextUsageDialog,
  });

  // ── "Interrupt then undo/redo" confirmation handlers (busy session) ──
  // Declared here because they depend on `interruptSession` from useMessageSender.
  const handleConfirmInterruptRevert = useCallback(() => {
    const pending = pendingRevert;
    setPendingRevert(null);
    if (!pending) return;
    // Abort first — daemon abort bypasses the command queue, and the queued
    // revert runs as soon as the aborted turn settles.
    interruptSession();
    if (pending.op === 'undo') {
      dispatchRevert(pending.target);
    } else {
      sendBridgeEvent('unrevert_session');
      applyRevertState(false);
    }
  }, [pendingRevert, interruptSession, dispatchRevert, applyRevertState]);

  const handleCancelInterruptRevert = useCallback(() => {
    setPendingRevert(null);
  }, []);

  // ── Message queue ──
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    dequeue: dequeueMessage,
  } = useMessageQueue({ isLoading: loading, isCompacting, onExecute: executeMessage });

  /**
   * 发送真实消息前消费 revert 边界。与 opencode 服务端语义一致：
   * prompt/command/shell/summarize 都会先执行 revert.cleanup——从边界消息起
   * 连同自身全部删除（无 partID）并清除 revert 指针。本地同步截断，避免
   * 占位条滞留、以及清除边界后被撤销的旧消息"复活"。
   */
  const consumeRevertBoundary = useCallback(() => {
    // Use the ref to avoid a stale closure: this callback is invoked from the
    // submit path where the `revertBoundaryId` state may not have caught up.
    const boundaryId = revertBoundaryIdRef.current;
    if (!hasRevertStateRef.current || !boundaryId) return;
    const idx = messages.findIndex((m) => getMessageId(m) === boundaryId);
    if (idx >= 0) {
      setMessages(messages.slice(0, idx));
    }
    applyRevertState(false);
  }, [messages, getMessageId, applyRevertState, setMessages]);

  // ── /compact 确认门：压缩不可撤销，先弹确认框，用户确认后才真正发送 ──
  const doCompact = useCallback(() => {
    consumeRevertBoundary();
    sendBridgeEvent('compact_session');
    setIsCompacting(true);
    setCompactingStartTime(Date.now());
  }, [consumeRevertBoundary, setIsCompacting, setCompactingStartTime]);
  const { showCompactConfirm, requestCompact, handleCompactConfirmed, handleCancelCompact } =
    useCompactConfirm(doCompact);

  // Handle opencode builtin session commands typed as slash commands
  // (mirror the TUI: /compact /undo /redo /fork /share /unshare).
  const handleBuiltinCommand = useCallback((command: string) => {
    switch (command) {
      case '/compact':
        // 先弹确认框；确认后 doCompact 才发送（不可撤销操作）。
        requestCompact();
        break;
      case '/undo': {
        const id = findLatestUserMessageId();
        if (id) {
          handleUndoMessage({ type: 'user', id } as ClaudeMessage);
        } else {
          // 本地无 id —— 交给宿主通过 listMessages 解析
          handleUndoMessage({ type: 'user' } as ClaudeMessage);
        }
        break;
      }
      case '/redo':
        handleRedoMessage();
        break;
      case '/fork':
        handleForkFull();
        break;
      case '/share':
        void handleShare();
        break;
      case '/unshare':
        void handleUnshare();
        break;
    }
  }, [requestCompact, handleUndoMessage, handleRedoMessage, handleForkFull, handleShare, handleUnshare]);

  // Reset revert / share / compact-confirm state on session switch
  useEffect(() => {
    applyRevertState(false);
    resetShareState();
    handleCancelCompact();
  }, [applyRevertState, resetShareState, currentSessionId, handleCancelCompact]);

  // handleSubmit with queue support (new session and local commands bypass loading check)
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!text && !hasAttachments) return;
    // Local commands work even while loading
    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].toLowerCase();
      // New session commands
      if (NEW_SESSION_COMMANDS.has(command)) {
        forceCreateNewSession();
        return;
      }
      // /resume - open history view
      if (RESUME_COMMANDS.has(command)) {
        setCurrentView('history');
        return;
      }
      // /plan - switch to plan mode (opencode has a native plan agent)
      if (PLAN_COMMANDS.has(command)) {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
        return;
      }
      // /context - handled locally even while loading
      if (CONTEXT_COMMANDS.has(command)) {
        hookHandleSubmit(content, attachments);
        return;
      }
      // opencode builtin session commands (compact/undo/redo/fork/share/unshare)
      if (BUILTIN_SESSION_COMMANDS.has(command)) {
        // /compact 在用户确认后才发送，revert 边界在确认时（doCompact）消费；
        // 其余（undo/redo/fork/share）是纯客户端操作，不影响服务端 revert 状态。
        handleBuiltinCommand(command);
        return;
      }
    }
    // 普通消息 / 队列消息 / !shell —— 服务端 prompt 前都会 cleanup revert
    consumeRevertBoundary();
    // If loading or compacting, add to queue
    if (loading || isCompacting) {
      enqueueMessage(content, attachments);
      return;
    }
    hookHandleSubmit(content, attachments);
  }, [loading, isCompacting, enqueueMessage, hookHandleSubmit, forceCreateNewSession, currentProvider, handleModeSelect, setCurrentView, addToast, t, handleBuiltinCommand, consumeRevertBoundary]);

  // ── Chat-view computations (stage 5 of TASK-P1-01) ──
  const {
    findToolResult, getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges, subagents, globalTodos, sessionTitle,
  } = useChatComputations({
    t, messages, mergedMessages, subagentHistories, customSessionTitle, streamingActive, currentProvider,
    currentSessionId, currentSessionIdRef,
    getMessageText, getContentBlocks, sseTodos,
  });

  const { handleUndoFile, handleDiscardAll: handleDiscardAllRaw, handleKeepAll } = fileChangeMgmt;
  const onDiscardAll = useCallback(
    () => { handleDiscardAllRaw(filteredFileChanges); },
    [handleDiscardAllRaw, filteredFileChanges],
  );

  // Stabilize context value references for SubagentContext consumers.
  const { subagentHistoryCtxValue, sessionIdCtxValue } = useSubagentContextValues(
    subagentHistories,
    currentSessionId,
    currentProvider,
  );

  const handleNavigateToProviderSettings = useCallback(() => {
    setSettingsInitialTab('providers');
    setCurrentView('settings');
  }, [setSettingsInitialTab, setCurrentView]);

  const statusPanelExpanded = !userCollapsedRef.current;

  // ── Render ──
  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <ChatHeader
        currentView={currentView}
        sessionTitle={sessionTitle}
        t={t}
        onBack={() => setCurrentView('chat')}
        onNewSession={createNewSession}
        onHistory={() => setCurrentView('history')}
        onSettings={() => {
          setSettingsInitialTab(undefined);
          setCurrentView('settings');
        }}
        onOpenSearch={() => setSearchOpen(true)}
        titleEditable
        onTitleChange={(newTitle) => {
          setCustomSessionTitle(newTitle);
          if (currentSessionId) {
            updateHistoryTitle(currentSessionId, newTitle);
          }
        }}
        isShared={isShared}
        sharePending={sharePending}
        shareHidden={shareHidden}
        onCopyShareLink={handleCopyShareLink}
        onShare={handleShare}
        onUnshare={handleUnshare}
        onForkAll={handleForkFull}
      />

      {currentView === 'settings' ? (
        <SettingsView
          onClose={() => setCurrentView('chat')}
          initialTab={settingsInitialTab}
          currentProvider={currentProvider}
          sendShortcut={sendShortcut}
          onSendShortcutChange={handleSendShortcutChange}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
          permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
          onPermissionDialogTimeoutChange={setPermissionDialogTimeoutSeconds}
        />
      ) : (
        <>
          {/* Keep ChatScreen mounted while browsing history so model catalog,
              scroll position, and draft attachments survive history ↔ chat. */}
          <div
            style={currentView === 'chat'
              ? { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }
              : { display: 'none' }}
          >
            <ChatScreen
              mergedMessages={mergedMessages}
              sessionTitle={sessionTitle}
              getMessageText={getMessageText}
              getContentBlocks={getContentBlocks}
              findToolResult={findToolResult}
              getToolResultRaw={getToolResultRaw}
              subagents={subagents}
              globalTodos={globalTodos}
              filteredFileChanges={filteredFileChanges}
              subagentHistoryCtxValue={subagentHistoryCtxValue}
              sessionIdCtxValue={sessionIdCtxValue}
              chatInputRef={chatInputRef}
              messagesContainerRef={messagesContainerRef}
              messagesEndRef={messagesEndRef}
              inputAreaRef={inputAreaRef}
              messageNodeMapRef={messageNodeMapRef}
              userCollapsedRef={userCollapsedRef}
              messageListRef={messageListRef}
              isAutoScrollingRef={isAutoScrollingRef}
              anchorCollapsedCount={anchorCollapsedCount}
              setAnchorCollapsedCount={setAnchorCollapsedCount}
              onMessageNodeRef={handleMessageNodeRef}
              statusPanelExpanded={statusPanelExpanded}
              forceStatusUpdate={forceStatusUpdate}
              onUndoFile={handleUndoFile}
              onDiscardAll={onDiscardAll}
              onKeepAll={handleKeepAll}
              onSubmit={handleSubmit}
              onInterrupt={interruptSession}
              onNavigateToProviderSettings={handleNavigateToProviderSettings}
              onProviderSelect={wrappedHandleProviderSelect}
              revertBoundaryId={revertBoundaryId}
              onUndo={handleUndoMessage}
              onRestore={handleRedoMessage}
              onFork={handleForkRequest}
              currentProvider={currentProvider}
              selectedModel={selectedModel}
              permissionMode={permissionMode}
              currentSdkInstalled={currentSdkInstalled}
              daemonStatusLoaded={daemonStatusLoaded}
              retryDaemonStatus={retryDaemonStatus}
              activeProviderConfig={activeProviderConfig}
              claudeSettingsAlwaysThinkingEnabled={claudeSettingsAlwaysThinkingEnabled}
              reasoningEffort={reasoningEffort}
              codexFastMode={codexFastMode}
              sendShortcut={sendShortcut}
              autoOpenFileEnabled={autoOpenFileEnabled}
              longContextEnabled={longContextEnabled}
              usagePercentage={usagePercentage}
              usageUsedTokens={usageUsedTokens}
              usageMaxTokens={usageMaxTokens}
              onModeSelect={handleModeSelect}
              onModelSelect={handleModelSelect}
              onReasoningChange={handleReasoningChange}
              onCodexFastModeChange={handleCodexFastModeChange}
              onToggleThinking={handleToggleThinking}
              onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
               onLongContextChange={handleLongContextChange}
               messageQueue={messageQueue}
              onRemoveFromQueue={dequeueMessage}
            />
          </div>
          {currentView === 'history' && (
            <HistoryView
              historyData={historyData}
              currentProvider={currentProvider}
              currentSessionId={currentSessionId}
              onLoadSession={loadHistorySession}
              onDeleteSession={deleteHistorySession}
              onDeleteSessions={deleteHistorySessions}
              onExportSession={exportHistorySession}
              onToggleFavorite={toggleFavoriteSession}
              onUpdateTitle={updateHistoryTitle}
              onConvertToCliSession={convertToCliSession}
            />
          )}
        </>
      )}

      <div id="image-preview-root" />

      <AppDialogs
        showNewSessionConfirm={showNewSessionConfirm}
        onConfirmNewSession={handleConfirmNewSession}
        onCancelNewSession={handleCancelNewSession}
        showInterruptConfirm={showInterruptConfirm}
        onConfirmInterrupt={handleConfirmInterrupt}
        onCancelInterrupt={handleCancelInterrupt}
        permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
      />

      <ConfirmDialog
        isOpen={pendingRevert !== null}
        title={pendingRevert?.op === 'undo' ? t('chat.undoTooltip') : t('chat.redoTooltip')}
        message={pendingRevert?.op === 'undo'
          ? t('chat.revertBusyConfirmMessage')
          : t('chat.restoreBusyConfirmMessage')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmInterruptRevert}
        onCancel={handleCancelInterruptRevert}
      />

      <ConfirmDialog
        isOpen={showCompactConfirm}
        title={t('chat.compactConfirmTitle')}
        message={t('chat.compactConfirmMessage')}
        confirmText={t('chat.compactConfirmAction')}
        cancelText={t('common.cancel')}
        onConfirm={handleCompactConfirmed}
        onCancel={handleCancelCompact}
      />
    </>
  );
};

export default App;
