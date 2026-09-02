import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle, Fragment } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, CodexHistoryPageInfo, ToolResultBlock } from '../types';
import { sendBridgeEvent } from '../utils/bridge';
import { MessageItem } from './MessageItem';
import WaitingIndicator from './WaitingIndicator';
import { ContextMenu } from './ContextMenu';
import { useContextMenu, copySelection } from '../hooks/useContextMenu.js';
import { quoteToChatInput } from '../utils/quoteUtils';
import type { MessageListRevealHandle } from './ConversationSearch/types';
import RevertPlaceholderBar, { extractPreviewText, type RevertedMessagePreview } from './MessageList/RevertPlaceholderBar';
import {
  DETAILED_OUTPUT_ENABLED_EVENT,
  getDetailedOutputEnabled,
  type DetailedOutputEnabledChangedDetail,
} from '../utils/detailedOutputPreference';

/** Keep pagination aligned to complete user turns so assistant/tool chains are never split. */
const INITIAL_VISIBLE_TURNS = 5;
const REVEAL_TURN_PAGE_SIZE = 5;
const HISTORY_DISK_PAGE_SIZE = 30;

function isHumanUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;

  const raw = typeof message.raw === 'object' && message.raw !== null ? message.raw : null;
  const nestedMessage = raw?.message;
  const rawContent = raw?.content ?? (
    typeof nestedMessage === 'object' && nestedMessage !== null ? nestedMessage.content : undefined
  );

  if (Array.isArray(rawContent)) {
    return rawContent.some((block) => block
      && typeof block === 'object'
      && (block.type === 'text' || block.type === 'image'));
  }

  return message.content !== '[tool_result]';
}

function getFirstMessageBoundaryKey(message: ClaudeMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (typeof message.id === 'string') return `id:${message.id}`;
  if (typeof message.raw === 'object' && message.raw !== null && typeof message.raw.uuid === 'string') {
    return `uuid:${message.raw.uuid}`;
  }
  if (message.timestamp) return `timestamp:${message.type}:${message.timestamp}`;
  return `content:${message.type}:${message.content ?? ''}`;
}

function extractToolResultPreview(result: ToolResultBlock | null | undefined): string {
  if (!result) return 'pending';

  let text = '';
  if (typeof result.content === 'string') {
    text = result.content;
  } else if (Array.isArray(result.content)) {
    text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  const preview = text.length > 200 ? text.slice(0, 200) : text;
  return `${result.is_error === true ? 'error' : 'ok'}:${text.length}:${preview}`;
}

function getMessageToolResultSignature(
  message: ClaudeMessage,
  messageIndex: number,
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined,
): string {
  const toolUses = getContentBlocks(message).filter(
    (block): block is Extract<ClaudeContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  );
  if (toolUses.length === 0) return '';

  return toolUses
    .map((block) => `${block.id ?? 'unknown'}:${extractToolResultPreview(findToolResult(block.id, messageIndex))}`)
    .join('|');
}

interface MessageListProps {
  messages: ClaudeMessage[];
  messageKeys: readonly string[];
  streamingActive: boolean;
  isThinking: boolean;
  loading: boolean;
  loadingStartTime: number | null;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onMessageNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  /** Notify parent when the number of collapsed (hidden) messages changes. */
  onCollapsedCountChange?: (count: number) => void;
  onNavigateToProviderSettings?: () => void;
  /** Current active provider id; forwarded to MessageItem for streaming-connect label. */
  currentProvider?: string;
  currentSessionId?: string | null;
  /**
   * opencode message id of the revert boundary (the undone user message).
   * When set, this message and everything after it is hidden behind a
   * RevertPlaceholderBar which carries the restore (redo) action.
   */
  revertBoundaryId?: string | null;
  /** Callback to undo a message */
  onUndo?: (message: ClaudeMessage) => void;
  /** Restore (redo) reverted messages — rendered on the placeholder bar. */
  onRestore?: () => void;
  /** Callback to fork from a message */
  onFork?: (message: ClaudeMessage) => void;
  /** Whether the session is currently streaming (disables fork). */
  forkDisabled?: boolean;
}

export const MessageList = memo(forwardRef<MessageListRevealHandle, MessageListProps>(function MessageList({
  messages,
  messageKeys,
  streamingActive,
  isThinking,
  loading,
  loadingStartTime,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  messagesEndRef,
  onMessageNodeRef,
  onCollapsedCountChange,
  onNavigateToProviderSettings,
  currentProvider,
  currentSessionId,
  revertBoundaryId,
  onUndo,
  onRestore,
  onFork,
  forkDisabled = false,
}, ref) {
  const [revealedTurnCount, setRevealedTurnCount] = useState(0);
  const [historyPageInfo, setHistoryPageInfo] = useState<CodexHistoryPageInfo | null>(null);
  const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
  const loadingEarlierHistoryRef = useRef(false);
  const [detailedOutputEnabled, setDetailedOutputEnabled] = useState(() =>
    getDetailedOutputEnabled()
  );

  // Context menu for message list (copy + quote, when text selected)
  const ctxMenu = useContextMenu();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleMessageContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      ctxMenu.open(e);
    }
  }, [ctxMenu.open]);

  // Hotkey (Ctrl/Cmd+Shift+Q): quote the current selection when it lives inside the message list.
  useEffect(() => {
    const handleQuoteHotkey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'q' || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      const sel = window.getSelection();
      const selectedText = sel?.toString() ?? '';
      if (!selectedText.trim()) return;
      const anchor = sel?.anchorNode ?? null;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      if (!containerRef.current || !anchorElement || !containerRef.current.contains(anchorElement)) return;
      event.preventDefault();
      quoteToChatInput(selectedText);
    };
    window.addEventListener('keydown', handleQuoteHotkey);
    return () => window.removeEventListener('keydown', handleQuoteHotkey);
  }, []);

  // Use explicit session identity in production; keep the message boundary for isolated callers/tests.
  const previousSessionRef = useRef(currentSessionId);
  const firstMessageBoundaryRef = useRef(getFirstMessageBoundaryKey(messages[0]));
  useEffect(() => {
    const currentBoundary = getFirstMessageBoundaryKey(messages[0]);
    const sessionChanged = currentSessionId != null
      ? currentSessionId !== previousSessionRef.current
      : currentBoundary !== firstMessageBoundaryRef.current;
    if (sessionChanged) {
      setRevealedTurnCount(0);
      setLoadingEarlierHistory(false);
      loadingEarlierHistoryRef.current = false;
      const cached = window.__codexHistoryPageInfo;
      setHistoryPageInfo(
        currentProvider === 'codex' && cached?.sessionId === currentSessionId ? cached ?? null : null,
      );
    }
    previousSessionRef.current = currentSessionId;
    firstMessageBoundaryRef.current = currentBoundary;
  }, [currentProvider, currentSessionId, messages]);

  useEffect(() => {
    const handlePageInfo = (event: Event) => {
      const info = (event as CustomEvent<CodexHistoryPageInfo>).detail;
      if (currentProvider !== 'codex' || !info || info.sessionId !== currentSessionId) return;
      setHistoryPageInfo(info);
      setLoadingEarlierHistory(false);
      loadingEarlierHistoryRef.current = false;
    };
    const handlePageError = (event: Event) => {
      const error = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!error?.sessionId || error.sessionId === currentSessionId) {
        setLoadingEarlierHistory(false);
        loadingEarlierHistoryRef.current = false;
      }
    };

    window.addEventListener('codex-history-page-info', handlePageInfo);
    window.addEventListener('codex-history-page-error', handlePageError);
    const cached = window.__codexHistoryPageInfo;
    if (currentProvider === 'codex' && cached?.sessionId === currentSessionId) {
      setHistoryPageInfo(cached ?? null);
    }
    return () => {
      window.removeEventListener('codex-history-page-info', handlePageInfo);
      window.removeEventListener('codex-history-page-error', handlePageError);
    };
  }, [currentProvider, currentSessionId]);

  /** Match a message against an opencode message id (top-level id or raw.id/raw.uuid). */
  const messageMatchesId = useCallback((message: ClaudeMessage, id: string): boolean => {
    if (typeof message.id === 'string' && message.id === id) return true;
    const raw = message.raw as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      if (typeof raw.id === 'string' && raw.id === id) return true;
      if (typeof raw.uuid === 'string' && raw.uuid === id) return true;
    }
    return false;
  }, []);

  // Revert boundary slicing: when a revert (undo) is active, hide the boundary
  // user message and everything after it behind a RevertPlaceholderBar. Applied
  // BEFORE pagination math so collapsed-turn bookkeeping stays consistent.
  const { displayMessages, revertedMessages } = useMemo(() => {
    if (!revertBoundaryId) return { displayMessages: messages, revertedMessages: [] as ClaudeMessage[] };
    const idx = messages.findIndex((m) => messageMatchesId(m, revertBoundaryId));
    if (idx < 0) {
      // Boundary not present in the loaded transcript (e.g. server already
      // filtered it) — keep the full list; the bar still renders via hasRevert.
      return { displayMessages: messages, revertedMessages: [] as ClaudeMessage[] };
    }
    return {
      displayMessages: messages.slice(0, idx),
      revertedMessages: messages.slice(idx),
    };
  }, [messages, revertBoundaryId, messageMatchesId]);

  const revertedPreviews = useMemo<RevertedMessagePreview[]>(
    () => revertedMessages.map((m) => ({
      role: m.type === 'user' ? 'user' as const : 'assistant' as const,
      text: extractPreviewText(m).slice(0, 400),
    })),
    [revertedMessages],
  );

  const userTurnStartIndexes = useMemo(
    () => displayMessages.reduce<number[]>((indexes, message, index) => {
      if (isHumanUserMessage(message)) indexes.push(index);
      return indexes;
    }, []),
    [displayMessages],
  );
  const visibleTurnCount = Math.min(
    userTurnStartIndexes.length,
    INITIAL_VISIBLE_TURNS + revealedTurnCount,
  );
  const hiddenTurnCount = userTurnStartIndexes.length - visibleTurnCount;
  const collapsedCount = hiddenTurnCount > 0 ? userTurnStartIndexes[hiddenTurnCount] : 0;
  const shouldCollapse = collapsedCount > 0;
  const nextTurnCount = Math.min(REVEAL_TURN_PAGE_SIZE, hiddenTurnCount);

  const canLoadEarlierFromDisk = Boolean(currentProvider === 'codex'
    && historyPageInfo?.sessionId === currentSessionId
    && historyPageInfo?.hasMore);
  const handleRevealMore = useCallback(() => {
    if (hiddenTurnCount > 0) {
      setRevealedTurnCount((prev) => prev + REVEAL_TURN_PAGE_SIZE);
      return;
    }
    if (!canLoadEarlierFromDisk || loadingEarlierHistoryRef.current || !currentSessionId || !historyPageInfo) {
      return;
    }

    loadingEarlierHistoryRef.current = true;
    setLoadingEarlierHistory(true);
    const sent = sendBridgeEvent('load_codex_history_page', JSON.stringify({
      sessionId: currentSessionId,
      beforeTurn: historyPageInfo.fromTurn,
    }));
    if (!sent) {
      loadingEarlierHistoryRef.current = false;
      setLoadingEarlierHistory(false);
    }
  }, [canLoadEarlierFromDisk, currentSessionId, hiddenTurnCount, historyPageInfo]);

  // Imperative API so the in-page search can expand everything before scanning.
  // Returns the number of messages that were just revealed (0 when nothing
  // was collapsed). This lets the search panel surface "Expanded N earlier
  // messages" exactly once per panel-open, per the agreed design.
  useImperativeHandle(ref, (): MessageListRevealHandle => ({
    revealAll: () => {
      const previouslyHidden = collapsedCount;
      if (previouslyHidden === 0) return 0;
      setRevealedTurnCount(userTurnStartIndexes.length);
      return previouslyHidden;
    },
  }), [collapsedCount, userTurnStartIndexes.length]);

  // Notify parent of collapsed count changes (for anchor rail sync)
  useLayoutEffect(() => {
    onCollapsedCountChange?.(collapsedCount);
  }, [collapsedCount, onCollapsedCountChange]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<DetailedOutputEnabledChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setDetailedOutputEnabled(custom.detail.enabled);
      }
    };
    window.addEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
    return () => window.removeEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
  }, []);

  const visibleMessages = useMemo(
    () => (shouldCollapse ? displayMessages.slice(collapsedCount) : displayMessages),
    [displayMessages, shouldCollapse, collapsedCount]
  );

  return (
    <div ref={containerRef} onContextMenu={handleMessageContextMenu}>
      {ctxMenu.visible && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={ctxMenu.close}
          items={[
            { label: t('contextMenu.quote', 'Quote'), action: () => quoteToChatInput(ctxMenu.selectedText) },
            { label: t('contextMenu.copy', 'Copy'), action: () => copySelection(ctxMenu.savedRange, ctxMenu.selectedText) },
          ]}
        />
      )}
      {(shouldCollapse || canLoadEarlierFromDisk) && (
        <div
          className="collapsed-messages-indicator"
          onClick={handleRevealMore}
        >
          {loadingEarlierHistory
            ? t('chat.loadingEarlierTurns')
            : shouldCollapse
              ? t('chat.showEarlierTurns', {
                count: nextTurnCount,
                remaining: hiddenTurnCount,
                total: historyPageInfo?.totalTurns,
              })
              : t('chat.loadEarlierTurns', {
                count: Math.min(HISTORY_DISK_PAGE_SIZE, historyPageInfo?.fromTurn ?? 0),
                remaining: historyPageInfo?.fromTurn ?? 0,
                total: historyPageInfo?.totalTurns ?? 0,
              })}
        </div>
      )}

      {visibleMessages.map((message, visibleIndex) => {
        const messageIndex = shouldCollapse ? visibleIndex + collapsedCount : visibleIndex;
        const messageKey = messageKeys[messageIndex];
        const toolResultSignature = getMessageToolResultSignature(message, messageIndex, getContentBlocks, findToolResult);

        const isLatestUserMessage = message.type === 'user' &&
          messageIndex === displayMessages.length - 1 ||
          (messageIndex < displayMessages.length - 1 &&
           displayMessages.slice(messageIndex + 1).some(m => m.type === 'user') === false);

        return (
          <Fragment key={messageKey}>
            <MessageItem
              message={message}
              messageIndex={messageIndex}
              messageKey={messageKey}
              isLast={messageIndex === displayMessages.length - 1}
              streamingActive={streamingActive}
              isThinking={isThinking}
              t={t}
              getMessageText={getMessageText}
              getContentBlocks={getContentBlocks}
              findToolResult={findToolResult}
              extractMarkdownContent={extractMarkdownContent}
              onNodeRef={onMessageNodeRef}
              onNavigateToProviderSettings={onNavigateToProviderSettings}
              toolResultSignature={toolResultSignature}
              currentProvider={currentProvider}
              detailedOutputEnabled={detailedOutputEnabled}
              isLatestUserMessage={isLatestUserMessage}
              onUndo={onUndo}
              onFork={onFork}
              forkDisabled={forkDisabled}
            />
          </Fragment>
        );
      })}

      {/* Revert boundary placeholder — carries the restore (redo) action */}
      {revertBoundaryId && (
        <RevertPlaceholderBar
          count={revertedMessages.length}
          previews={revertedPreviews}
          onRestore={() => onRestore?.()}
        />
      )}

      {/* Loading indicator */}
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </div>
  );
}));
