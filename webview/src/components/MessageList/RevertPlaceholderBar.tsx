import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../../types';
import { MessageItem } from '../MessageItem';

export interface RevertedMessagePreview {
  role: 'user' | 'assistant';
  text: string;
}

export interface RevertPlaceholderBarProps {
  /** Number of messages hidden by the revert boundary. */
  count: number;
  /** Lightweight text previews of the hidden messages (for the expandable view fallback). */
  previews?: RevertedMessagePreview[];
  /** Full messages hidden by the revert boundary. */
  revertedMessages?: ClaudeMessage[];
  /** Restore (redo) the reverted messages. */
  onRestore: () => void;
  // Render helpers for full message items
  t?: TFunction;
  getMessageText?: (message: ClaudeMessage) => string;
  getContentBlocks?: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult?: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent?: (message: ClaudeMessage) => string;
  onNavigateToProviderSettings?: () => void;
  currentProvider?: string;
  detailedOutputEnabled?: boolean;
}

/** Extract plain-text preview from a chat message (top-level content or raw blocks). */
function extractPreviewText(message: ClaudeMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }
  const raw = message.raw as
    | { content?: unknown; message?: { content?: unknown } }
    | string
    | undefined;
  if (raw && typeof raw === 'object') {
    const blocks = raw.content ?? raw.message?.content;
    if (Array.isArray(blocks)) {
      return blocks
        .map((b) => {
          const block = b as { text?: unknown; content?: unknown; type?: unknown };
          if (typeof block?.text === 'string') return block.text;
          // tool results keep their payload in content[]
          if (block?.type === 'tool_result' && typeof block.content === 'string') return block.content;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

/**
 * Collapsed placeholder for a revert (undo) boundary — option A of the
 * share/undo/redo/fork UX design. Renders where the reverted user message used
 * to be, shows how many messages were undone, an expandable preview, and the
 * restore (redo) action.
 */
const RevertPlaceholderBar = ({
  count,
  previews,
  revertedMessages,
  onRestore,
  t: customT,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  onNavigateToProviderSettings,
  currentProvider,
  detailedOutputEnabled,
}: RevertPlaceholderBarProps) => {
  const { t } = useTranslation();
  const activeT = customT || t;
  const [expanded, setExpanded] = useState(false);

  const hasItems = (revertedMessages && revertedMessages.length > 0) || (previews && previews.length > 0) || count > 0;

  return (
    <div className="revert-placeholder-bar" data-testid="revert-placeholder-bar">
      <div className="revert-placeholder-row">
        <span className="codicon codicon-history revert-placeholder-icon" />
        <span className="revert-placeholder-text">
          {count > 0
            ? activeT('chat.revertPlaceholderCount', { count })
            : activeT('chat.revertPlaceholderTitle')}
        </span>
        <button
          type="button"
          className="revert-placeholder-btn"
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasItems}
        >
          {expanded ? activeT('chat.revertCollapse') : activeT('chat.revertExpand')}
        </button>
        <button
          type="button"
          className="revert-placeholder-btn revert-restore-btn"
          onClick={onRestore}
          title={activeT('chat.redoTooltip')}
        >
          <span className="codicon codicon-redo" />
          {activeT('chat.revertRestore')}
        </button>
      </div>
      {expanded && (
        <div className="reverted-messages-expanded-wrapper">
          {revertedMessages && revertedMessages.length > 0 ? (
            <div className="reverted-messages-expanded-container" data-testid="reverted-messages-container">
              {revertedMessages.map((message, i) => (
                <MessageItem
                  key={message.id || (message.raw as any)?.id || (message.raw as any)?.uuid || `reverted-${i}`}
                  message={message}
                  messageIndex={i}
                  messageKey={`reverted-${i}`}
                  isLast={i === revertedMessages.length - 1}
                  streamingActive={false}
                  isThinking={false}
                  t={activeT}
                  getMessageText={getMessageText || ((m) => (typeof m.content === 'string' ? m.content : ''))}
                  getContentBlocks={getContentBlocks || (() => [])}
                  findToolResult={findToolResult || (() => undefined)}
                  extractMarkdownContent={extractMarkdownContent || ((m) => (typeof m.content === 'string' ? m.content : ''))}
                  onNavigateToProviderSettings={onNavigateToProviderSettings}
                  currentProvider={currentProvider}
                  detailedOutputEnabled={detailedOutputEnabled}
                  isLatestUserMessage={false}
                  onUndo={undefined}
                  onFork={undefined}
                  forkDisabled={true}
                />
              ))}
            </div>
          ) : previews && previews.length > 0 ? (
            <div className="revert-placeholder-preview" data-testid="revert-placeholder-preview">
              {previews.map((p, i) => (
                <div key={i} className={`revert-preview-line revert-preview-${p.role}`}>
                  <span className="revert-preview-role">{p.role === 'user' ? activeT('common.you', 'You') : 'AI'}</span>
                  <span className="revert-preview-content">{p.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default RevertPlaceholderBar;
export { extractPreviewText };
