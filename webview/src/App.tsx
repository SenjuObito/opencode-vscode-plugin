import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import { sendHostCommand, sendSessionCommand, sendWindowCommand } from './utils/bridge';
import { createTabId, getTabStore } from './store/tabStore';
import { registerHostEvents, unregisterHostEvents } from './utils/hostEventRegistry';
import { copyViaHost } from './utils/copyUtils';
import { preloadSlashCommands } from './components/ChatInputBox/providers';
import { useCliModels } from './hooks/providers/useCliModels';
import { getFirstPreferredModelId } from './components/ChatInputBox/modelSelectUtils';
import { resolveProviderModels } from './components/ChatInputBox/resolveProviderModels';
import { getRecommendedReasoningEffort } from './components/ChatInputBox/types';
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
import { createCompactSuccessNotice, createCompactFailureNotice, applyMessagesRemoved } from './utils/messageUtils';
import { parseRevertStateEvent } from './utils/revertStateEvent';
import type { ClaudeMessage } from './types';
import type { Attachment, ChatInputBoxHandle } from './components/ChatInputBox/types';
import type { SessionTabData } from './components/ChatHeader/types';
import { ToastContainer } from './components/Toast';
import { ChatHeader } from './components/ChatHeader';
import { ChatScreen } from './components/ChatScreen';
import type { MessageListRevealHandle } from './components/ConversationSearch/types';
import { useSubagentContextValues, useSetTaskEvents, useTaskEvents } from './contexts/SubagentContext';
import { useMessages } from './contexts/MessagesContext';
import { useSession } from './contexts/SessionContext';
import { useUIState } from './contexts/UIStateContext';
import { useDialogs } from './contexts/DialogContext';
import { AppDialogs } from './components/AppDialogs';
import ConfirmDialog from './components/ConfirmDialog';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from './utils/permissionDialogTimeout';
import { useSessionTabs } from './hooks/useSessionTabs';
import { convertMessagesToMarkdown, downloadMarkdown } from './utils/exportMarkdown';

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
    status, setStatus,
    loading, setLoading, loadingStartTime, setLoadingStartTime,
    isThinking, setIsThinking,
    streamingActive, setStreamingActive,
    sessionLoading, setSessionLoading,
    setSseTodos,
    sseTodos,
    isCompacting, setIsCompacting,
    compactingStartTime, setCompactingStartTime,
  } = useMessages();

  // task_events live in TaskEventProvider (SubagentContext) so their updates do
  // not re-render every MessagesContext consumer.
  const setTaskEvents = useSetTaskEvents();
  const taskEvents = useTaskEvents();

  const openSessionInTabRef = useRef<((
    sessionId: string,
    title?: string,
    historyModel?: string,
    historyMode?: string,
    historyEffort?: string,
    reservedTabId?: string,
  ) => void) | null>(null);
  const appTabsRef = useRef<SessionTabData[]>([]);

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
    contextInfo, setContextInfo,
    searchOpen, setSearchOpen,
  } = useUIState();

  // ── Permission dialog timeout (synced with backend config) ──
  const [permissionDialogTimeoutSeconds, setPermissionDialogTimeoutSeconds] = useState(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);

  // ── Multi-view lifecycle ─────────────────────────────────────────────
  // `view.ready` makes the host resync tabs/agents for this freshly mounted
  // webview; focus/blur drives prompt-host election so only one view shows
  // permission dialogs.
  useEffect(() => {
    sendWindowCommand('view.ready');
    const reportFocus = () => {
      sendWindowCommand('view.focus', { focused: document.hasFocus() });
    };
    reportFocus();
    window.addEventListener('focus', reportFocus);
    window.addEventListener('blur', reportFocus);
    return () => {
      window.removeEventListener('focus', reportFocus);
      window.removeEventListener('blur', reportFocus);
    };
  }, []);

  // 页面切换在视图间同步（设置页/历史页）；发送方由宿主回显时忽略。
  useEffect(() => {
    sendWindowCommand('view.navigate', { view: currentView });
  }, [currentView]);

  // ── Local refs (don't trigger re-render, kept in App.tsx) ──
  const isFirstMountRef = useRef(true);
  const chatInputRef = useRef<ChatInputBoxHandle>(null);

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
    captureScrollState, restoreScrollState,
  } = useScrollBehavior({ currentView, messages, loading, streamingActive });

  // ── Streaming messages ──
  const {
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    streamingMessageIndexRef, contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    lastContentUpdateRef, lastThinkingUpdateRef, autoExpandedThinkingKeysRef,
    streamingTurnIdRef, turnIdCounterRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
    deleteRuntimeForTab,
    setRuntimeStreamingForTab,
  } = useStreamingMessages();

  // (Toast helpers moved to UIStateContext)

  // ── Model/Provider state ──
  const {
    currentProvider, selectedModel, permissionMode,
    daemonStatusLoaded, retryDaemonStatus, currentSdkInstalled, daemonEngine,
    currentProviderRef,
    activeProviderConfig,
    reasoningEffort, sendShortcut, autoOpenFileEnabled,
    usagePercentage, usageUsedTokens, usageMaxTokens,
    setPermissionMode, setCurrentProvider,
    setOpenCodePermissionMode,
    setSelectedOpenCodeModel,
    setReasoningEffort,
    setSendShortcut, setAutoOpenFileEnabled,
    setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    handleModeSelect, handleModelSelect,
    handleReasoningChange,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
  } = useModelProviderState({ addToast, t, currentSessionId, currentSessionIdRef });

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

  const { cliModels, cliDefaultModel, cliCatalogHasEntries } = useCliModels(currentProvider);

  const availableModels = useMemo(() => {
    return resolveProviderModels({
      provider: currentProvider,
      cliModels,
      cliCatalogHasEntries,
    });
  }, [currentProvider, cliModels, cliCatalogHasEntries]);

  /**
   * A user-chosen model carries its own variant catalog. Carry the previous
   * model's effort over only when it is still meaningful; otherwise use the
   * new model's recommended level. In particular this prevents a `none`
   * variant from surviving a model switch and becoming the visible default.
   * A tab restore (`silent`) keeps that tab's saved effort.
   */
  const handleModelSelectWithEffort = useCallback((modelId: string, options?: { silent?: boolean }) => {
    const modelChanged = modelId !== selectedModel;
    handleModelSelect(modelId, options);
    if (options?.silent || !modelChanged) return;

    const modelInfo = availableModels.find((model) => model.id === modelId);
    const recommended = getRecommendedReasoningEffort(modelInfo?.variants);
    if (recommended && recommended !== reasoningEffort) {
      handleReasoningChange(recommended);
    }
  }, [handleModelSelect, handleReasoningChange, availableModels, selectedModel, reasoningEffort]);

  const resetToPreferredModel = useCallback(() => {
    const preferredId = getFirstPreferredModelId(currentProvider, availableModels, cliDefaultModel);
    if (preferredId) {
      handleModelSelectWithEffort(preferredId);
    }
  }, [currentProvider, availableModels, cliDefaultModel, handleModelSelectWithEffort]);

  // When models catalog arrives on initial load in a new session, immediately select the preferred model.
  const hasAutoSelectedOnStartupRef = useRef(false);
  useEffect(() => {
    if (hasAutoSelectedOnStartupRef.current) return;
    if (!cliCatalogHasEntries || !cliModels.length) return;
    if (currentSessionId === null && messages.length === 0) {
      hasAutoSelectedOnStartupRef.current = true;
      resetToPreferredModel();
    }
  }, [cliCatalogHasEntries, cliModels, currentSessionId, messages.length, resetToPreferredModel]);

  // ── Session management ──
  const {
    showInterruptConfirm,
    suppressNextStatusToastRef,
    forceCreateNewSession,
    handleConfirmInterrupt, handleCancelInterrupt,
    loadHistorySession, deleteHistorySession, deleteHistorySessions, exportHistorySession,
    toggleFavoriteSession, updateHistoryTitle, applyHistoryTitleLocal,
  } = useSessionManagement({
    messages, loading, historyData, currentSessionId, currentSessionIdRef, currentProvider,
    setHistoryData, setMessages, setCurrentView, setCurrentSessionId,
    setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setStatus, setLoading, setIsThinking, setStreamingActive, setSessionLoading,
    setIsCompacting, setCompactingStartTime,
    setTaskEvents,
    setSseTodos,
    setSubagentHistories,
    onResetToPreferredModel: resetToPreferredModel,
    clearToasts, addToast, t,
  });

  const reloadHistory = useHistoryLoader({ currentView, currentProvider });

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
    sendSessionCommand('session.share', currentSessionId);
  }, [currentSessionId, sharePending, shareHidden]);

  const handleUnshare = useCallback(async () => {
    if (!currentSessionId) return;
    sendSessionCommand('session.unshare', currentSessionId);
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
  const lastLoadedRevertStateRef = useRef<string>('');

  /**
   * 同步更新 revert 状态的 ref 与 boundary（ref 供回调内做变更检测，避开闭包旧值）。
   * messageId 是服务端 revert 指针指向的用户消息 id，占位条据此定位切片。
   */
  const applyRevertState = useCallback((next: boolean, messageId?: string | null) => {
    hasRevertStateRef.current = next;
    revertBoundaryIdRef.current = next ? (messageId ?? null) : null;
    if (typeof window !== 'undefined') {
      window.__hasActiveRevert = next;
    }
    setRevertBoundaryId(next ? (messageId ?? null) : null);
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
    });
  }, [scrollToBottom, userPausedRef, isUserAtBottomRef]);

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

  const extractPromptText = useCallback((message: ClaudeMessage | null | undefined): string => {
    if (!message) return '';
    let target = message;
    const id = getMessageId(message);
    if (!target.content && messages.length > 0) {
      if (id && id !== 'latest') {
        target = messages.find((m) => getMessageId(m) === id) || target;
      } else {
        target = [...messages].reverse().find((m) => m.type === 'user' && !m.content?.includes('[tool_result]')) || target;
      }
    }
    let text = target.content || '';
    if (!text && target.raw) {
      const raw = target.raw as Record<string, unknown>;
      if (typeof raw === 'string') {
        text = raw;
      } else if (typeof raw.content === 'string') {
        text = raw.content;
      } else if (Array.isArray(raw.content)) {
        text = (raw.content as any[])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
      } else if (raw.message && typeof raw.message === 'object') {
        const inner = raw.message as Record<string, unknown>;
        if (typeof inner.content === 'string') {
          text = inner.content;
        }
      }
    }
    return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }, [messages, getMessageId]);

  /**
   * Send the revert/unrevert bridge event. Caller must have settled any
   * busy-session confirmation beforehand (see pendingRevert flow).
   */
  const dispatchRevert = useCallback((message: ClaudeMessage) => {
    const id = getMessageId(message);
    const sid = currentSessionIdRef.current;

    // 回填被撤销消息的 prompt 到输入框供用户编辑
    const promptText = extractPromptText(message);
    if (promptText && chatInputRef.current?.setValue) {
      chatInputRef.current.setValue(promptText);
      chatInputRef.current.focus?.();
    }

    if (!id) {
      // live 消息尚未回填 opencode id —— 让宿主通过 listMessages 解析最后一条用户消息
      console.warn('[App] undo: message has no id; falling back to backend latest-user resolution');
      sendSessionCommand('session.revert', sid, { messageId: 'latest' });
      applyRevertState(true, 'latest');
      return;
    }
    console.debug('[App] undo: reverting to message', id);
    sendSessionCommand('session.revert', sid, { messageId: id });
    // Optimistic: boundary is the undone user message; the host's
    // onRevertStateUpdate push carries the authoritative pointer.
    applyRevertState(true, id);
  }, [applyRevertState, getMessageId, extractPromptText, currentSessionIdRef]);

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
    const sid = currentSessionIdRef.current;
    sendSessionCommand('session.unrevert', sid, {});
    applyRevertState(false);
    if (sid) {
      loadHistorySession(sid);
    }
  }, [applyRevertState, streamingActive, currentSessionIdRef, loadHistorySession]);

  // Confirm/cancel handlers live below, after `interruptSession` (useMessageSender)
  // exists — see handleConfirmInterruptRevert.

  const handleForkRequest = useCallback((message: ClaudeMessage) => {
    if (streamingActive) {
      addToast(t('chat.forkDisabledTooltip'), 'warning');
      return;
    }
    const id = getMessageId(message);
    const sid = currentSessionIdRef.current ?? currentSessionId;
    const sourceTabId = getTabStore().findIdBySession(sid) ?? getTabStore().getActiveTabId() ?? '';
    if (!sourceTabId) return;
    const targetTabId = createTabId();
    if (!id) {
      console.warn('[App] fork: message has no id; falling back to backend latest-user resolution');
      sendHostCommand(sourceTabId, 'session.fork', { sourceTabId, targetTabId, messageId: 'latest' });
      return;
    }
    sendHostCommand(sourceTabId, 'session.fork', { sourceTabId, targetTabId, messageId: id });
  }, [streamingActive, addToast, t, getMessageId, currentSessionId, currentSessionIdRef]);

  /** 全量 fork（Header 按钮 + 斜杠 /fork）：复制整个会话，不带 messageID。 */
  const handleForkFull = useCallback(() => {
    if (streamingActive) {
      addToast(t('chat.forkDisabledTooltip'), 'warning');
      return;
    }
    const sid = currentSessionIdRef.current ?? currentSessionId;
    const sourceTabId = getTabStore().findIdBySession(sid) ?? getTabStore().getActiveTabId() ?? '';
    if (!sourceTabId) return;
    sendHostCommand(sourceTabId, 'session.fork', {
      sourceTabId,
      targetTabId: createTabId(),
    });
  }, [streamingActive, addToast, t, currentSessionId, currentSessionIdRef]);

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
    const handleRevertStateEvent = (...args: unknown[]) => {
      try {
        const parsed = parseRevertStateEvent(args);
        if (!parsed) return;
        const { hasRevert, messageId, sessionId: wireSessionId } = parsed;
        console.debug('[App] revert.changed', { wireSessionId, hasRevert, messageId });
        const store = getTabStore();
        if (wireSessionId && store.size() > 0 && !store.isActiveSession(wireSessionId)) {
          store.updateBackgroundTab(wireSessionId, (tab) => {
            tab.revertBoundaryId = hasRevert ? messageId : null;
          });
          return;
        }
        const prevHasRevert = hasRevertStateRef.current;
        const prevId = revertBoundaryIdRef.current;
        const changed = hasRevert !== prevHasRevert || messageId !== prevId;
        const activeTabId = store.getActiveTabId();
        if (activeTabId) {
          store.updateTab(activeTabId, (tab) => {
            tab.revertBoundaryId = hasRevert ? messageId : null;
          });
        }
        applyRevertState(hasRevert, messageId);

        const targetSessionId = wireSessionId || currentSessionIdRef.current;
        const currentKey = `${targetSessionId}:${hasRevert}:${messageId}`;
        if (changed || (hasRevert && lastLoadedRevertStateRef.current !== currentKey)) {
          lastLoadedRevertStateRef.current = currentKey;
          if (targetSessionId) {
            loadHistorySession(targetSessionId);
          }
        }
      } catch (err) {
        console.warn('[App] malformed revert.changed payload', err, args);
      }
    };

    const handleMessagesRemovedEvent = (...args: unknown[]) => {
      try {
        const first = args[0];
        const second = args[1];
        const hasTwo = typeof second !== 'undefined';
        const targetSessionId = hasTwo && typeof first === 'string' ? first : null;
        const rawIds = hasTwo ? second : first;
        const parsed = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
        if (!Array.isArray(parsed) || parsed.length === 0) return;
        const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) return;
        console.debug('[App] message.removed', targetSessionId, ids);
        const store = getTabStore();
        if (targetSessionId && store.size() > 0 && !store.isActiveSession(targetSessionId)) {
          store.updateBackgroundTab(targetSessionId, (tab) => {
            tab.messages = applyMessagesRemoved(tab.messages ?? [], ids);
          });
          return;
        }
        setMessages((prev) => applyMessagesRemoved(prev, ids));
      } catch {
        // ignore malformed payloads
      }
    };

    window.onRevertStateUpdate = (json: string) => {
      handleRevertStateEvent(json);
    };
    // 服务端权威删除：opencode 在下一次 prompt 时把 revert 点之后的消息真正删掉，
    // 并逐条广播 message.removed；宿主镜像删除后转发到这里。先把自己列表里的这些
    // 消息剔除，使随后到达的 updateMessages 快照与 prev 等长 —— 否则
    // preserveLatestMessagesOnShrink 会把它当成「暂时收缩」，把刚删的消息抢救回来。
    window.onMessagesRemoved = (json: string) => {
      handleMessagesRemovedEvent(json);
    };
    window.onCompactSuccess = (targetSessionId?: string) => {
      if (targetSessionId && currentSessionIdRef.current && targetSessionId !== currentSessionIdRef.current) {
        return;
      }
      setIsCompacting(false);
      setCompactingStartTime(null);
      setMessages((prev) => [...prev, createCompactSuccessNotice(t('chat.compactSuccess'))]);
      // Force scroll to bottom after compact completes
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    };
    window.onCompactError = (targetSessionId?: string, detail?: string) => {
      if (targetSessionId && currentSessionIdRef.current && targetSessionId !== currentSessionIdRef.current) {
        return;
      }
      setIsCompacting(false);
      setCompactingStartTime(null);
      setMessages((prev) => [...prev, createCompactFailureNotice(t('chat.compactFailed'), detail)]);
    };
    // Named command results (G8 command plane): the host publishes these with
    // legacy:false, so the window.<fn> assignments above are only the fallback
    // for a view that has not mounted this effect yet.
    const onForkBound = (payload: Record<string, unknown>) => {
      const targetTabId = typeof payload.targetTabId === 'string' ? payload.targetTabId : '';
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (!targetTabId || !sessionId) return;
      const activeId = getTabStore().getActiveTabId();
      const currentTabs = appTabsRef.current || [];
      const sourceTab =
        (typeof payload.sourceTabId === 'string'
          ? currentTabs.find((tab) => tab.id === payload.sourceTabId)
          : undefined) ||
        (typeof payload.sourceSessionId === 'string'
          ? currentTabs.find((tab) => tab.sessionId === payload.sourceSessionId)
          : undefined) ||
        (activeId ? currentTabs.find((tab) => tab.id === activeId && tab.id !== targetTabId) : undefined) ||
        currentTabs.find((tab) => tab.id !== targetTabId);
      const forkedTitle = sourceTab ? `${sourceTab.title} (Fork)` : `${customSessionTitleRef.current || 'Session'} (Fork)`;
      openSessionInTabRef.current?.(sessionId, forkedTitle, undefined, undefined, undefined, targetTabId);
      addToast(t('chat.forkCreatedToast'), 'success');
    };

    registerHostEvents({
      'session.fork.bound': onForkBound,
      'session.fork.failed': (payload: Record<string, unknown>) => {
        window.onForkError?.(String(payload.data ?? payload.error ?? ''));
      },
      'session.share.done': (payload: Record<string, unknown>) => {
        window.onShareSuccess?.(String(payload.data ?? payload.url ?? ''));
      },
      'session.share.failed': (payload: Record<string, unknown>) => {
        window.onShareError?.(String(payload.data ?? payload.error ?? ''));
      },
      'session.unshare.done': () => {
        window.onUnshareSuccess?.();
      },
      'session.unshare.failed': (payload: Record<string, unknown>) => {
        window.onUnshareError?.(String(payload.data ?? payload.error ?? ''));
      },
      'session.revert.failed': (payload: Record<string, unknown>) => {
        window.onRevertError?.(JSON.stringify({
          op: String(payload.op ?? 'undo'),
          error: String(payload.error ?? ''),
        }));
      },
      'revert.changed': handleRevertStateEvent,
      'message.removed': handleMessagesRemovedEvent,
      'session.compact.done': (payload: Record<string, unknown>) => {
        window.onCompactSuccess?.(String(payload.data ?? payload.sessionId ?? ''));
      },
      'session.compact.failed': (payload: Record<string, unknown>) => {
        window.onCompactError?.(String(payload.data ?? ''), String(payload.error ?? ''));
      },
    });

    return () => {
      unregisterHostEvents([
        'session.fork.bound', 'session.fork.failed',
        'session.share.done', 'session.share.failed',
        'session.unshare.done', 'session.unshare.failed',
        'session.revert.failed',
        'revert.changed',
        'message.removed',
        'session.compact.done', 'session.compact.failed',
      ]);
      delete window.onForkSuccess;
      delete window.onForkError;
      delete window.onShareSuccess;
      delete window.onShareError;
      delete window.onRevertError;
      delete window.onRevertStateUpdate;
      delete window.onMessagesRemoved;
      delete window.onCompactSuccess;
      delete window.onCompactError;
    };
  }, [applyRevertState, loadHistorySession, currentSessionIdRef, addToast, t, setMessages, setIsCompacting, setCompactingStartTime, scrollToBottom, customSessionTitleRef]);

  // ── Window callbacks (bridge communication) ──
  useWindowCallbacks({
    t, addToast, clearToasts,
    setMessages, setStatus, setLoading, setLoadingStartTime,
    setIsThinking, setStreamingActive, setSessionLoading, setHistoryData,
    setIsCompacting, setCompactingStartTime,
    setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setPermissionMode, setCurrentProvider,
    setOpenCodePermissionMode,
    setSelectedOpenCodeModel,
    setReasoningEffort,
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
  const {
    handleSubmit: hookHandleSubmit,
    executeMessage,
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, selectedModel, permissionMode, reasoningEffort,
    daemonStatusLoaded, currentSdkInstalled,
    sentAttachmentsRef, chatInputRef, messagesContainerRef,
    isUserAtBottomRef, userPausedRef, isStreamingRef,
    // Streaming buffers + throttle handles — interruptSession needs them to
    // drop buffered content and cancel queued rAFs when the user hits stop.
    streamingContentRef, streamingThinkingRef,
    contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    setMessages, setLoading, setLoadingStartTime, setStreamingActive,
    setCurrentView,
    forceCreateNewSession,
    handleModeSelect,
    openContextUsageDialog,
    closeContextUsageDialog,
    currentSessionId,
    currentSessionIdRef,
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
      sendSessionCommand('session.unrevert', currentSessionIdRef.current);
      applyRevertState(false);
    }
  }, [pendingRevert, interruptSession, dispatchRevert, applyRevertState, currentSessionIdRef]);

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
    if (!hasRevertStateRef.current) return;
    let idx = -1;
    if (boundaryId) {
      idx = messages.findIndex((m) => getMessageId(m) === boundaryId);
    }
    if (idx < 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'user' && !m.content?.includes('[tool_result]')) {
          idx = i;
          break;
        }
      }
    }
    if (idx >= 0) {
      const remainingMessages = messages.slice(0, idx);
      setMessages(remainingMessages);
      const activeTabId = getTabStore().getActiveTabId();
      if (activeTabId) {
        getTabStore().updateTab(activeTabId, (tab) => {
          tab.messages = remainingMessages;
          tab.revertBoundaryId = null;
        });
      }
    }
    applyRevertState(false);
  }, [messages, getMessageId, applyRevertState, setMessages]);

  // ── /compact 确认门：压缩不可撤销，先弹确认框，用户确认后才真正发送 ──
  const doCompact = useCallback(() => {
    consumeRevertBoundary();
    sendSessionCommand('session.compact', currentSessionIdRef.current);
    setIsCompacting(true);
    setCompactingStartTime(Date.now());
  }, [consumeRevertBoundary, setIsCompacting, setCompactingStartTime, currentSessionIdRef]);
  const { showCompactConfirm, requestCompact, handleCompactConfirmed, handleCancelCompact } =
    useCompactConfirm(doCompact);

  // "Don't ask again" checkbox state for the compact confirm dialog.
  // Resets to unchecked every time the dialog re-opens.
  const [skipCompactAgain, setSkipCompactAgain] = useState(false);
  useEffect(() => {
    if (showCompactConfirm) {
      setSkipCompactAgain(false);
    }
  }, [showCompactConfirm]);

  const handleConfirmCompactWithSkip = useCallback(() => {
    handleCompactConfirmed(skipCompactAgain);
  }, [handleCompactConfirmed, skipCompactAgain]);

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

  // Reset share / compact-confirm state on session switch
  // 切换会话时不再抹杀 revert 状态，因为各 Tab 拥有自己独立的 revertBoundaryId
  useEffect(() => {
    resetShareState();
    handleCancelCompact();
    setIsCompacting(false);
    setCompactingStartTime(null);
  }, [resetShareState, currentSessionId, handleCancelCompact, setIsCompacting, setCompactingStartTime]);

  // handleSubmit with queue support (new session and local commands bypass loading check)
  const handleSubmit = useCallback((
    content: string,
    attachments?: Attachment[],
    fileTags?: { displayPath: string; absolutePath: string }[],
  ) => {
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
        hookHandleSubmit(content, attachments, fileTags);
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
    hookHandleSubmit(content, attachments, fileTags);
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

  const {
    tabs,
    activeTabId,
    selectTab,
    createTab,
    closeTab,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    closeAllTabs,
    renameTab,
    forkTab,
    reorderTabs,
    openSessionInTab,
    activeTabAutoOpenFileEnabled,
    setActiveTabAutoOpenFileEnabled,
    statusPanelExpanded,
    statusPanelTab,
    setStatusPanelTab,
    toggleStatusPanel,
  } = useSessionTabs({
    currentSessionId,
    currentSessionIdRef,
    setCurrentSessionId,
    sessionTitle,
    setCustomSessionTitle,
    updateHistoryTitle,
    messages,
    setMessages,
    loading,
    setLoading,
    streamingActive,
    setStreamingActive,
    isThinking,
    setIsThinking,
    status,
    setStatus,
    sessionLoading,
    setSessionLoading,
    revertBoundaryId,
    setRevertBoundaryId,
    isCompacting,
    setIsCompacting,
    compactingStartTime,
    setCompactingStartTime,
    taskEvents,
    setTaskEvents,
    sseTodos,
    setSseTodos,
    subagentHistories,
    setSubagentHistories,
    filteredFileChanges,
    permissionMode,
    setPermissionMode,
    selectedModel,
    setSelectedModel: handleModelSelectWithEffort,
    reasoningEffort,
    setReasoningEffort: handleReasoningChange,
    contextInfo,
    setContextInfo,
    loadingStartTime,
    setLoadingStartTime,
    usagePercentage,
    setUsagePercentage,
    usageUsedTokens,
    setUsageUsedTokens,
    usageMaxTokens,
    setUsageMaxTokens,
    availableModels,
    currentProvider,
    isShared,
    setCurrentView,
    chatInputRef,
    defaultAutoOpenFileEnabled: autoOpenFileEnabled,
    forceCreateNewSession,
    loadHistorySession,
    deleteTabRuntime: deleteRuntimeForTab,
    setTabRuntimeStreaming: setRuntimeStreamingForTab,
    captureScrollState,
    restoreScrollState,
    t,
  });

  useEffect(() => {
    openSessionInTabRef.current = openSessionInTab;
    appTabsRef.current = tabs;
  }, [openSessionInTab, tabs]);

  // ── Render ──
  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <ChatHeader
        currentView={currentView}
        t={t}
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onCloseTabsToLeft={closeTabsToLeft}
        onCloseTabsToRight={closeTabsToRight}
        onCloseAllTabs={closeAllTabs}
        onRenameTab={renameTab}
        onForkTab={forkTab}
        onReorderTabs={reorderTabs}
        onShareTab={(tab) => {
          if (tab.id !== activeTabId) selectTab(tab.id);
          void handleShare();
        }}
        onCopyShareLinkTab={(tab) => {
          if (tab.id !== activeTabId) selectTab(tab.id);
          handleCopyShareLink();
        }}
        onUnshareTab={(tab) => {
          if (tab.id !== activeTabId) selectTab(tab.id);
          void handleUnshare();
        }}
        onBack={() => setCurrentView('chat')}
        onNewSession={createTab}
        onHistory={() => setCurrentView('history')}
        onSettings={() => {
          setSettingsInitialTab(undefined);
          setCurrentView('settings');
        }}
        onOpenSearch={() => setSearchOpen(true)}
        onExportTab={(tab) => {
          const tabMessages = tab.id === activeTabId ? messages : (tab.messages || []);
          const title = tab.title || t('common.newSession', { defaultValue: '新会话' });
          const md = convertMessagesToMarkdown(tabMessages, title);
          downloadMarkdown(md, `${title}.md`);
          addToast(t('history.exportSuccess', { defaultValue: '会话已导出' }), 'success');
        }}
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
              messageListRef={messageListRef}
              isAutoScrollingRef={isAutoScrollingRef}
              anchorCollapsedCount={anchorCollapsedCount}
              setAnchorCollapsedCount={setAnchorCollapsedCount}
              onMessageNodeRef={handleMessageNodeRef}
              statusPanelExpanded={statusPanelExpanded}
              statusPanelTab={statusPanelTab}
              onStatusPanelTabChange={setStatusPanelTab}
              onToggleStatusPanel={toggleStatusPanel}
              onUndoFile={handleUndoFile}
              onDiscardAll={onDiscardAll}
              onKeepAll={handleKeepAll}
              onSubmit={handleSubmit}
              onInterrupt={interruptSession}
              onNavigateToProviderSettings={handleNavigateToProviderSettings}
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
              daemonEngine={daemonEngine}
              activeProviderConfig={activeProviderConfig}
              reasoningEffort={reasoningEffort}
              sendShortcut={sendShortcut}
              autoOpenFileEnabled={activeTabAutoOpenFileEnabled}
              usagePercentage={usagePercentage}
              usageUsedTokens={usageUsedTokens}
              usageMaxTokens={usageMaxTokens}
              onModeSelect={handleModeSelect}
              onModelSelect={handleModelSelectWithEffort}
              onReasoningChange={handleReasoningChange}
              onAutoOpenFileEnabledChange={setActiveTabAutoOpenFileEnabled}
              messageQueue={messageQueue}
              onRemoveFromQueue={dequeueMessage}
            />
          </div>
          {currentView === 'history' && (
            <HistoryView
              historyData={historyData}
              onLoadSession={(sessionId) => {
                const session = historyData?.sessions?.find(s => s.sessionId === sessionId);
                if (openSessionInTabRef.current) {
                  openSessionInTabRef.current(
                    sessionId,
                    session?.title,
                    session?.model,
                    session?.agent || (session as any)?.mode,
                    (session as any)?.reasoningEffort,
                  );
                } else {
                  loadHistorySession(sessionId);
                }
              }}
              onDeleteSession={deleteHistorySession}
              onDeleteSessions={deleteHistorySessions}
              onExportSession={exportHistorySession}
              onToggleFavorite={toggleFavoriteSession}
              onUpdateTitle={updateHistoryTitle}
              onRetry={reloadHistory}
            />
          )}
        </>
      )}

      <div id="image-preview-root" />

      <AppDialogs
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
        onConfirm={handleConfirmCompactWithSkip}
        onCancel={handleCancelCompact}
      >
        <label className="confirm-dialog-dont-ask-again">
          <input
            type="checkbox"
            checked={skipCompactAgain}
            onChange={(e) => setSkipCompactAgain(e.target.checked)}
          />
          <span>{t('common.dontAskAgain')}</span>
        </label>
      </ConfirmDialog>
    </>
  );
};

export default App;
