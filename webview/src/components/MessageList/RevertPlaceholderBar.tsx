import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeMessage } from '../../types';

export interface RevertedMessagePreview {
  role: 'user' | 'assistant';
  text: string;
}

interface RevertPlaceholderBarProps {
  /** Number of messages hidden by the revert boundary. */
  count: number;
  /** Lightweight text previews of the hidden messages (for the expandable view). */
  previews: RevertedMessagePreview[];
  /** Restore (redo) the reverted messages. */
  onRestore: () => void;
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
const RevertPlaceholderBar = ({ count, previews, onRestore }: RevertPlaceholderBarProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="revert-placeholder-bar" data-testid="revert-placeholder-bar">
      <div className="revert-placeholder-row">
        <span className="codicon codicon-history revert-placeholder-icon" />
        <span className="revert-placeholder-text">
          {count > 0
            ? t('chat.revertPlaceholderCount', { count })
            : t('chat.revertPlaceholderTitle')}
        </span>
        <button
          type="button"
          className="revert-placeholder-btn"
          onClick={() => setExpanded((v) => !v)}
          disabled={previews.length === 0}
        >
          {expanded ? t('chat.revertCollapse') : t('chat.revertExpand')}
        </button>
        <button
          type="button"
          className="revert-placeholder-btn revert-restore-btn"
          onClick={onRestore}
          title={t('chat.redoTooltip')}
        >
          <span className="codicon codicon-redo" />
          {t('chat.revertRestore')}
        </button>
      </div>
      {expanded && (
        <div className="revert-placeholder-preview">
          {previews.map((p, i) => (
            <div key={i} className={`revert-preview-line revert-preview-${p.role}`}>
              <span className="revert-preview-role">{p.role === 'user' ? t('common.you', 'You') : 'AI'}</span>
              <span className="revert-preview-content">{p.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RevertPlaceholderBar;
export { extractPreviewText };
