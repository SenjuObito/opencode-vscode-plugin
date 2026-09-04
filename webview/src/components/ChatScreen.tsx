import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatInputBox } from './ChatInputBox';
import type {
  Attachment,
  ChatInputBoxHandle,
} from './ChatInputBox/types';
import { MessageAnchorRail } from './MessageAnchorRail';
import { MessageList } from './MessageList';
import { ScrollControl } from './ScrollControl';
import { StatusPanel, StatusPanelErrorBoundary } from './StatusPanel';
import { WelcomeScreen } from './WelcomeScreen';
import { ConversationSearch } from './ConversationSearch';
import type { MessageListRevealHandle } from './ConversationSearch/types';
import ConfirmDialog from './ConfirmDialog';
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
import { cardDebugLog } from '../utils/bridge';

type SubagentHistoryMap = ReturnType<typeof useMessages>['subagentHistories'];
type ProviderState = ReturnType<typeof useModelProviderState>;
type MessageQueueValue = ReturnType<typeof useMessageQueue>['queue'];
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
  userCollapsedRef: RefObject<boolean>;
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
  forceStatusUpdate: React.Dispatch<React.SetStateAction<number>>;
  onUndoFile: FileChangeMgmt['handleUndoFile'];
  onDiscardAll: () => void;
  onKeepAll: FileChangeMgmt['handleKeepAll'];

  // Submit / interrupt / nav
  onSubmit: (content: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onNavigateToProviderSettings: () => void;
  onProviderSelect: (providerId: string) => void;

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
  activeProviderConfig: ProviderState['activeProviderConfig'];
  claudeSettingsAlwaysThinkingEnabled: ProviderState['claudeSettingsAlwaysThinkingEnabled'];
  reasoningEffort: ProviderState['reasoningEffort'];
  codexFastMode: ProviderState['codexFastMode'];
  sendShortcut: ProviderState['sendShortcut'];
  autoOpenFileEnabled: ProviderState['autoOpenFileEnabled'];
  longContextEnabled: ProviderState['longContextEnabled'];
  usagePercentage: ProviderState['usagePercentage'];
  usageUsedTokens: ProviderState['usageUsedTokens'];
  usageMaxTokens: ProviderState['usageMaxTokens'];

  // Model handlers
  onModeSelect: ProviderState['handleModeSelect'];
  onModelSelect: ProviderState['handleModelSelect'];
  onReasoningChange: ProviderState['handleReasoningChange'];
  onCodexFastModeChange: ProviderState['handleCodexFastModeChange'];
  onToggleThinking: ProviderState['handleToggleThinking'];
  onAutoOpenFileEnabledChange: ProviderState['handleAutoOpenFileEnabledChange'];
  onLongContextChange: ProviderState['handleLongContextChange'];

  // Message queue
  messageQueue: MessageQueueValue;
  onRemoveFromQueue: (id: string) => void;
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
  messageNodeMapRef, userCollapsedRef, messageListRef, isAutoScrollingRef,
  anchorCollapsedCount, setAnchorCollapsedCount, onMessageNodeRef,
  statusPanelExpanded, forceStatusUpdate,
  onUndoFile, onDiscardAll, onKeepAll,
  onSubmit, onInterrupt,
  onNavigateToProviderSettings, onProviderSelect,
  revertBoundaryId,
  onUndo,
  onRestore,
  onFork,
  currentProvider, selectedModel, permissionMode,
  currentSdkInstalled,
  daemonStatusLoaded,
  retryDaemonStatus,
  activeProviderConfig, claudeSettingsAlwaysThinkingEnabled,
  reasoningEffort, codexFastMode, sendShortcut, autoOpenFileEnabled,
  longContextEnabled, usagePercentage, usageUsedTokens, usageMaxTokens,
  onModeSelect, onModelSelect, onReasoningChange, onCodexFastModeChange, onToggleThinking,
  onAutoOpenFileEnabledChange, onLongContextChange,
  messageQueue, onRemoveFromQueue,
}: ChatScreenProps) => {
  const { t } = useTranslation();
  const { messages, loading, isThinking, streamingActive, loadingStartTime, subagentHistories, sessionLoading } = useMessages();
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

  // Compact is destructive (opencode summarizes the conversation and prunes
  // older messages). Prompt the user before firing the slash command so an
  // accidental click on the token ring does not silently erase context.
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);
  const handleCompact = useCallback(() => {
    setShowCompactConfirm(true);
  }, []);
  const handleCompactConfirm = useCallback(() => {
    setShowCompactConfirm(false);
    onSubmit('/compact');
  }, [onSubmit]);
  const handleCompactCancel = useCallback(() => {
    setShowCompactConfirm(false);
  }, []);

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

  return (
    <>
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
                <MessageList
                  ref={messageListRef}
                  messages={mergedMessages}
                  messageKeys={messageKeySnapshot.keys}
                  streamingActive={streamingActive}
                  isThinking={isThinking}
                  loading={loading}
                  loadingStartTime={loadingStartTime}
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
                  forkDisabled={streamingActive}
                />
              </ToolResultRawContext.Provider>
            </SubagentHistoryContext.Provider>
          </SessionIdContext.Provider>
        </div>
      </div>

      <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />

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
          isStreaming={streamingActive}
          onUndoFile={onUndoFile}
          onDiscardAll={onDiscardAll}
          onKeepAll={onKeepAll}
        />
      </StatusPanelErrorBoundary>

      <div className="input-area" ref={inputAreaRef}>
        <ChatInputBox
          ref={chatInputRef}
          isLoading={loading}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          currentProvider={currentProvider}
          usagePercentage={usagePercentage}
          usageUsedTokens={usageUsedTokens}
          usageMaxTokens={usageMaxTokens}
          showUsage={true}
          alwaysThinkingEnabled={activeProviderConfig?.settingsConfig?.alwaysThinkingEnabled ?? claudeSettingsAlwaysThinkingEnabled}
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
          onProviderSelect={onProviderSelect}
          reasoningEffort={reasoningEffort}
          onReasoningChange={onReasoningChange}
          codexFastMode={codexFastMode}
          onCodexFastModeChange={onCodexFastModeChange}
          onToggleThinking={onToggleThinking}
          sendShortcut={sendShortcut}
          activeFile={contextInfo?.file}
          selectedLines={contextInfo?.startLine !== undefined && contextInfo?.endLine !== undefined
            ? (contextInfo.startLine === contextInfo.endLine
                ? `L${contextInfo.startLine}`
                : `L${contextInfo.startLine}-${contextInfo.endLine}`)
            : undefined}
          onClearContext={() => setContextInfo(null)}
          onOpenModelSettings={() => {
            setAddModelDialogOpen(true);
          }}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={() => {
            userCollapsedRef.current = !userCollapsedRef.current;
            forceStatusUpdate((c) => c + 1);
          }}
          addToast={addToast}
          messageQueue={messageQueue}
          onRemoveFromQueue={onRemoveFromQueue}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={onAutoOpenFileEnabledChange}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          onCompactClick={handleCompact}
        />
      </div>
      <ConfirmDialog
        isOpen={showCompactConfirm}
        title={t('chat.compactConfirmTitle')}
        message={t('chat.compactConfirmMessage')}
        confirmText={t('chat.compactConfirmAction')}
        cancelText={t('common.cancel')}
        onConfirm={handleCompactConfirm}
        onCancel={handleCompactCancel}
      />
    </>
  );
};
