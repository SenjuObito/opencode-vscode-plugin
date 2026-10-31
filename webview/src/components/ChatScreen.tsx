import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatInputBox } from './ChatInputBox';
import type {
  Attachment,
  ChatInputBoxHandle,
} from './ChatInputBox/types';
import { MessageAnchorRail } from './MessageAnchorRail';
import { MessageList } from './MessageList';
import { MessagesErrorBoundary } from './MessagesErrorBoundary';
import { EngineBlockedNotice } from './EngineBlockedNotice';
import { ScrollControl } from './ScrollControl';
import { StatusPanel, StatusPanelErrorBoundary } from './StatusPanel';
import type { TabType } from './StatusPanel/types';
import { WelcomeScreen } from './WelcomeScreen';
import { ConversationSearch } from './ConversationSearch';
import type { MessageListRevealHandle } from './ConversationSearch/types';
import {
  SessionIdContext,
  SubagentHistoryContext,
  ToolResultRawContext,
} from '../contexts/SubagentContext';
import { useMessages } from '../contexts/MessagesContext';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { extractMarkdownContent } from '../utils/copyUtils';
import type { ClaudeMessage, TodoItem, ToolResultBlock } from '../types';
import type { useMessageProcessing, useFileChanges, useSubagents, useFileChangesManagement, useModelProviderState, useMessageQueue } from '../hooks';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';
import { reconcileMessageKeys, type MessageKeySnapshot } from '../utils/messageUtils';
import { cardDebugLog, sendHostCommand } from '../utils/bridge';
import { getTabStore } from '../store/tabStore';

type SubagentHistoryMap = ReturnType<typeof useMessages>['subagentHistories'];
type ProviderState = ReturnType<typeof useModelProviderState>;
type MessageQueueValue = ReturnType<typeof useMessageQueue>['queue'];
type QueueError = ReturnType<typeof useMessageQueue>['lastError'];
type SubagentList = ReturnType<typeof useSubagents>;
type FileChangeList = ReturnType<typeof useFileChanges>;
type FileChangeMgmt = ReturnType<typeof useFileChangesManagement>;

export interface ChatScreenProps {
  // Computed message data
  mergedMessages: ClaudeMessage[];
  sessionTitle: string;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: ReturnType<typeof useMessageProcessing>['getContentBlocks'];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;

  // Subagent / status panel data
  subagents: SubagentList;
  globalTodos: TodoItem[];
  filteredFileChanges: FileChangeList;
  subagentHistoryCtxValue: SubagentHistoryMap;
  sessionIdCtxValue: { currentSessionId: string | null; currentProvider: string };

  // Refs
  chatInputRef: RefObject<ChatInputBoxHandle | null>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  inputAreaRef: RefObject<HTMLDivElement | null>;
  messageNodeMapRef: RefObject<Map<string, HTMLDivElement>>;
  /** Imperative handle exposing `revealAll()` to the in-page search panel. */
  messageListRef: RefObject<MessageListRevealHandle | null>;
  /** Cooperate with useScrollBehavior to avoid pausing auto-follow during search scrolls. */
  isAutoScrollingRef?: React.RefObject<boolean>;

  // Anchor rail
  anchorCollapsedCount: number;
  setAnchorCollapsedCount: React.Dispatch<React.SetStateAction<number>>;
  onMessageNodeRef: (id: string, node: HTMLDivElement | null) => void;

  // Status panel
  statusPanelExpanded: boolean;
  /** 当前 tab 展开的状态面板子页（受控；切 tab 各自恢复） */
  statusPanelTab?: TabType | null;
  onStatusPanelTabChange?: (tab: TabType | null) => void;
  onToggleStatusPanel: () => void;
  onUndoFile: FileChangeMgmt['handleUndoFile'];
  onDiscardAll: () => void;
  onKeepAll: FileChangeMgmt['handleKeepAll'];

  // Submit / interrupt / nav
  onSubmit: (content: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onNavigateToProviderSettings: () => void;

  // Undo/Redo/Fork
  /** opencode message id of the revert boundary (drives RevertPlaceholderBar). */
  revertBoundaryId?: string | null;
  onUndo?: (message: ClaudeMessage) => void;
  onRestore?: () => void;
  onFork?: (message: ClaudeMessage) => void;

  // Model / provider state (slice from useModelProviderState)
  currentProvider: ProviderState['currentProvider'];
  selectedModel: ProviderState['selectedModel'];
  permissionMode: ProviderState['permissionMode'];
  currentSdkInstalled: ProviderState['currentSdkInstalled'];
  daemonStatusLoaded: boolean;
  retryDaemonStatus: () => void;
  daemonEngine?: import('../hooks/providers/useUsageTracking').DaemonEngineStatus | null;
  activeProviderConfig: ProviderState['activeProviderConfig'];
  reasoningEffort: ProviderState['reasoningEffort'];
  sendShortcut: ProviderState['sendShortcut'];
  autoOpenFileEnabled: ProviderState['autoOpenFileEnabled'];
  usagePercentage: ProviderState['usagePercentage'];
  usageUsedTokens: ProviderState['usageUsedTokens'];
  usageMaxTokens: ProviderState['usageMaxTokens'];

  // Model handlers
  onModeSelect: ProviderState['handleModeSelect'];
  onModelSelect: ProviderState['handleModelSelect'];
  onReasoningChange: ProviderState['handleReasoningChange'];
  onAutoOpenFileEnabledChange: ProviderState['handleAutoOpenFileEnabledChange'];

  // Message queue (host-owned projection of the active tab)
  messageQueue: MessageQueueValue;
  /** True after a stop: the queue waits for an explicit resume. */
  queuePaused?: boolean;
  /** Last send failure the host reported for an item it put back. */
  queueError?: QueueError;
  onRemoveFromQueue: (id: string) => void;
  onResumeQueue?: () => void;
}

/**
 * Renders the chat view (messages list, status panel, input box, scroll control).
 * Reads loading / streaming flags directly from MessagesContext, navigation
 * actions from UIStateContext, and currentSessionId from SessionContext to
 * avoid prop drilling those fields from App.tsx.
 *
 * Stage 5 of TASK-P1-01.
 */
export const ChatScreen = ({
  mergedMessages, getMessageText, getContentBlocks, findToolResult, getToolResultRaw,
  subagents, globalTodos, filteredFileChanges,
  subagentHistoryCtxValue, sessionIdCtxValue,
  chatInputRef, messagesContainerRef, messagesEndRef, inputAreaRef,
  messageNodeMapRef, messageListRef, isAutoScrollingRef,
  anchorCollapsedCount, setAnchorCollapsedCount, onMessageNodeRef,
  statusPanelExpanded, statusPanelTab, onStatusPanelTabChange, onToggleStatusPanel,
  onUndoFile, onDiscardAll, onKeepAll,
  onSubmit, onInterrupt,
  onNavigateToProviderSettings,
  revertBoundaryId,
  onUndo,
  onRestore,
  onFork,
  currentProvider, selectedModel, permissionMode,
  currentSdkInstalled,
  daemonStatusLoaded,
  retryDaemonStatus,
  daemonEngine,
  activeProviderConfig,
  reasoningEffort, sendShortcut, autoOpenFileEnabled,
  usagePercentage, usageUsedTokens, usageMaxTokens,
  onModeSelect, onModelSelect, onReasoningChange,
  onAutoOpenFileEnabledChange,
  messageQueue, queuePaused, queueError,
  onRemoveFromQueue, onResumeQueue,
}: ChatScreenProps) => {
  const { t } = useTranslation();
  const { messages, loading, isThinking, streamingActive, turnActive, loadingStartTime, subagentHistories, sessionLoading, isCompacting, compactingStartTime, historyWindow } = useMessages();
  cardDebugLog('[ChatScreen] render, sessionLoading:', sessionLoading, 'statusPanelExpanded:', statusPanelExpanded);
  const { currentSessionId } = useSession();
  const previousMessageKeySnapshotRef = useRef<MessageKeySnapshot | undefined>(undefined);
  const messageKeySnapshot = useMemo(
    () => reconcileMessageKeys(
      mergedMessages,
      previousMessageKeySnapshotRef.current,
      `${currentProvider}:${currentSessionId ?? 'active-session'}`,
    ),
    [currentProvider, currentSessionId, mergedMessages],
  );
  useLayoutEffect(() => {
    previousMessageKeySnapshotRef.current = messageKeySnapshot;
  }, [messageKeySnapshot]);
  const {
    contextInfo, setContextInfo,
    setAddModelDialogOpen,
    addToast,
    draftInput, setDraftInput,
    searchOpen, setSearchOpen,
  } = useUIState();
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    onSubmit(content, attachments);
  }, [onSubmit]);

  const handleCompact = useCallback(() => {
    onSubmit('/compact');
  }, [onSubmit]);

  /** Ask the host for one older page of this tab's transcript (disk paging). */
  const handleLoadEarlierHistory = useCallback(() => {
    const tabId = getTabStore().getActiveTabId() ?? '';
    if (!tabId) return;
    sendHostCommand(tabId, 'session.loadEarlier', {}, currentSessionId ?? null);
  }, [currentSessionId]);

  // Signal that the search hook can listen to for re-scanning. Combines
  // length + last timestamp + streaming flag + last-message content size.
  //
  // The content size is REQUIRED because during streaming the last assistant
  // message accumulates content while length / timestamp / isStreaming all
  // stay the same — without this sub-signal the hook would never re-scan the
  // new chunks (see code review feedback).
  //
  // ClaudeMessage.content is `string | undefined` at the top level, but the
  // streaming pipeline actually appends to `raw.message.content[]` (an array
  // of content blocks: text / tool_use / tool_result). Assistant tool-calling
  // messages are ALWAYS array-shaped on `raw`, so measuring ONLY top-level
  // string content silently freezes the signal in the most common streaming
  // case. We measure both shapes by summing inner text lengths.
  const searchSignal = useMemo(() => {
    const last = mergedMessages[mergedMessages.length - 1];
    let lastLen = 0;
    if (typeof last?.content === 'string') {
      lastLen = last.content.length;
    }
    // Walk raw blocks (text/tool_use/tool_result) and sum their textual size.
    // `raw` is either an object with `content[]` or `message.content[]`, or
    // sometimes a plain string. We use a tolerant shape with `unknown`.
    const rawHolder = last?.raw as
      | { content?: unknown; message?: { content?: unknown } }
      | string
      | undefined;
    const rawBlocks =
      typeof rawHolder === 'object' && rawHolder !== null
        ? rawHolder.content ?? rawHolder.message?.content
        : undefined;
    if (Array.isArray(rawBlocks)) {
      for (const block of rawBlocks) {
        const b = block as { text?: unknown; content?: unknown };
        if (typeof b.text === 'string') lastLen += b.text.length;
        else if (typeof b.content === 'string') lastLen += b.content.length;
      }
    }
    return `${mergedMessages.length}|${last?.timestamp ?? ''}|${last?.isStreaming ? 'S' : 'F'}|${lastLen}`;
  }, [mergedMessages]);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
  }, [setSearchOpen]);

  // 空态（无消息、非加载中）才显示极光/点阵底纹；有内容就退回纯色，
  // 免得背景污染历史与设置页（§10.3 的验收判据）。
  //
  // 画布作用域必须是整个 chat-screen-shell：状态面板与输入区都是消息列表的
  // 兄弟节点，若底纹只挂在 messages-shell 上，面板展开后下方会露出 #app 的
  // 主题侧边栏色，形成一条纯黑断层（与 idea 03f87d7 / 2baec63 同一修法）。
  const isEmptyState = !sessionLoading && mergedMessages.length === 0;

  return (
    <div className={`chat-screen-shell${isEmptyState ? ' is-empty-state' : ''}`}>
      <div className="messages-shell">
        <MessageAnchorRail
          messages={mergedMessages}
          messageKeys={messageKeySnapshot.keys}
          collapsedCount={anchorCollapsedCount}
          containerRef={messagesContainerRef}
          messageNodeMap={messageNodeMapRef}
        />
        <ConversationSearch
          open={searchOpen}
          onClose={handleSearchClose}
          containerRef={messagesContainerRef}
          messagesSignal={searchSignal}
          messageListRef={messageListRef}
          isAutoScrollingRef={isAutoScrollingRef}
        />
        <div className="messages-container" ref={messagesContainerRef}>
          {!sessionLoading && messages.length === 0 && (
            <WelcomeScreen
              currentProvider={currentProvider}
              t={t}
            />
          )}

          <SessionIdContext.Provider value={sessionIdCtxValue}>
            <SubagentHistoryContext.Provider value={subagentHistoryCtxValue}>
              <ToolResultRawContext.Provider value={getToolResultRaw}>
                <MessagesErrorBoundary currentSessionId={currentSessionId} t={t}>
                <MessageList
                  ref={messageListRef}
                  messages={mergedMessages}
                  messageKeys={messageKeySnapshot.keys}
                  streamingActive={streamingActive}
                  isThinking={isThinking}
                  loading={loading}
                  loadingStartTime={loadingStartTime}
                  isCompacting={isCompacting}
                  compactingStartTime={compactingStartTime}
                  t={t}
                  getMessageText={getMessageText}
                  getContentBlocks={getContentBlocks}
                  findToolResult={findToolResult}
                  extractMarkdownContent={extractMarkdownContent}
                  messagesEndRef={messagesEndRef}
                  onMessageNodeRef={onMessageNodeRef}
                  onCollapsedCountChange={setAnchorCollapsedCount}
                  onNavigateToProviderSettings={onNavigateToProviderSettings}
                  currentProvider={currentProvider}
                  currentSessionId={currentSessionId}
                  revertBoundaryId={revertBoundaryId}
                  onUndo={onUndo}
                  onRestore={onRestore}
                  onFork={onFork}
                  turnActive={turnActive}
                  forkDisabled={streamingActive}
                  hasEarlierHistory={historyWindow?.hasEarlier ?? false}
                  historyLoadedCount={historyWindow?.loadedCount ?? 0}
                  loadedTurns={historyWindow?.loadedTurns ?? 0}
                  totalTurns={historyWindow?.totalTurns ?? null}
                  historyWindowLoading={historyWindow?.loading ?? false}
                  onLoadEarlierHistory={handleLoadEarlierHistory}
                />
                </MessagesErrorBoundary>
              </ToolResultRawContext.Provider>
            </SubagentHistoryContext.Provider>
          </SessionIdContext.Provider>
        </div>
      </div>

      <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />

      {/* Retry / quota notice lives above the composer
          (`ChatInputBoxHeader` → `StatusNoticeBar`, 与 idea 同一挂载点)。这里
          只保留 VS Code 专属的「daemon 引擎不可用」提示 —— 它不属于额度条，
          混在一起会让两份实现继续分叉。 */}
      <EngineBlockedNotice engine={daemonEngine} onRetry={retryDaemonStatus} />

      <StatusPanelErrorBoundary>
        <StatusPanel
          todos={globalTodos}
          fileChanges={filteredFileChanges}
          subagents={subagents}
          subagentHistories={subagentHistories}
          currentSessionId={currentSessionId}
          currentProvider={currentProvider}
          sessionLoading={sessionLoading}
          expanded={statusPanelExpanded}
          activeTab={statusPanelTab}
          onActiveTabChange={onStatusPanelTabChange}
          isStreaming={streamingActive}
          onUndoFile={onUndoFile}
          onDiscardAll={onDiscardAll}
          onKeepAll={onKeepAll}
        />
      </StatusPanelErrorBoundary>

      <div className="input-area" ref={inputAreaRef}>
        <ChatInputBox
          ref={chatInputRef}
          isLoading={turnActive}
          messages={mergedMessages}
          getMessageText={getMessageText}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          currentProvider={currentProvider}
          usagePercentage={usagePercentage}
          usageUsedTokens={usageUsedTokens}
          usageMaxTokens={usageMaxTokens}
          showUsage={true}
          alwaysThinkingEnabled={activeProviderConfig?.settingsConfig?.alwaysThinkingEnabled}
          placeholder={sendShortcut === 'cmdEnter' ? t('chat.inputPlaceholderCmdEnter') : t('chat.inputPlaceholderEnter')}
          sdkInstalled={currentSdkInstalled}
          daemonStatusLoaded={daemonStatusLoaded}
          onRetryDaemonStatus={retryDaemonStatus}
          sessionLoading={sessionLoading}
          value={draftInput}
          onInput={setDraftInput}
          onSubmit={handleSubmit}
          onStop={onInterrupt}
          onModeSelect={onModeSelect}
          onModelSelect={onModelSelect}
          reasoningEffort={reasoningEffort}
          onReasoningChange={onReasoningChange}
          sendShortcut={sendShortcut}
          activeFile={autoOpenFileEnabled ? contextInfo?.file : undefined}
          selectedLines={autoOpenFileEnabled && contextInfo?.startLine !== undefined && contextInfo?.endLine !== undefined
            ? (contextInfo.startLine === contextInfo.endLine
                ? `L${contextInfo.startLine}`
                : `L${contextInfo.startLine}-${contextInfo.endLine}`)
            : undefined}
          onClearContext={() => setContextInfo(null)}
          onOpenModelSettings={() => {
            setAddModelDialogOpen(true);
          }}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={onToggleStatusPanel}
          addToast={addToast}
          messageQueue={messageQueue}
          queuePaused={queuePaused ?? false}
          queueError={queueError ?? null}
          onRemoveFromQueue={onRemoveFromQueue}
          onResumeQueue={onResumeQueue}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={onAutoOpenFileEnabledChange}
          onCompactClick={handleCompact}
        />
      </div>
    </div>
  );
};
