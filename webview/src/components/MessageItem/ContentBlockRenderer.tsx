import { useState, useEffect, useCallback, useRef, useSyncExternalStore, memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock, CompactSummaryMetadata } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import { QuestionAnswerSummary, type QuestionSummaryItem } from './QuestionAnswerSummary';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  TaskExecutionBlock,
} from '../toolBlocks';
import type { EditToolItem } from '../toolBlocks/EditToolBlock';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, TASK_MANAGE_TOOL_NAMES, AGENT_TOOL_NAMES, isToolName, isTransientInternalToolName, normalizeToolName } from '../../utils/toolConstants';
import { copyToClipboard } from '../../utils/copyUtils';
import { TASK_STATUS_COLORS } from '../../utils/messageUtils';
import { getQuestionAnswer, subscribe as subscribeQuestionAnswer, getSnapshot as getQuestionAnswerSnapshot } from '../../store/questionAnswerStore';

const IMAGE_BLOCK_STYLE: React.CSSProperties = { cursor: 'pointer' };

/**
 * Stable adapter for a single edit call. Building the one-item array inline in
 * render would hand EditToolBlock a fresh array (and wrapper object) on every
 * parent render and defeat its memo. Routing through this memoized wrapper
 * means EditToolBlock only re-renders when the underlying call's primitives
 * actually change, so it stays quiet while sibling blocks drive the streaming
 * message's frequent re-renders.
 */
const SingleEditToolBlock = memo(function SingleEditToolBlock({
  name,
  input,
  result,
  toolId,
}: EditToolItem) {
  return <EditToolBlock items={[{ name, input, result, toolId }]} />;
});

function getImageStyle(isUser: boolean): React.CSSProperties {
  return {
    maxWidth: isUser ? '200px' : '100%',
    maxHeight: isUser ? '150px' : 'auto',
    borderRadius: '8px',
    objectFit: 'contain',
  };
}

/**
 * Get file icon class (consistent with AttachmentList)
 */
function getFileIcon(mediaType?: string): string {
  if (!mediaType) return 'codicon-file';
  if (mediaType.startsWith('text/')) return 'codicon-file-text';
  if (mediaType.includes('json')) return 'codicon-json';
  if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
  if (mediaType.includes('pdf')) return 'codicon-file-pdf';
  return 'codicon-file';
}

/**
 * Get file extension
 */
function getExtension(fileName?: string): string {
  if (!fileName) return '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}

/** Format a token count for compact display (e.g., 524835 → "524.8K"). */
function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Format a compaction duration: "48s", "1m 50s". */
function formatCompactionDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Weak stats trailing the title. The post-compaction size is always known; the
 * before → after delta and the freed share only exist for history records that
 * still carry `preTokens`.
 */
function buildCompactionStats(meta: CompactSummaryMetadata, t: TFunction): string[] {
  const parts: string[] = [];
  const pre = typeof meta.preTokens === 'number' ? meta.preTokens : undefined;
  const post = typeof meta.postTokens === 'number' ? meta.postTokens : undefined;

  if (pre !== undefined && post !== undefined) {
    parts.push(t('chat.compactSummary.tokensBeforeAfter', {
      before: formatCompactTokens(pre),
      after: formatCompactTokens(post),
      defaultValue: '{{before}} → {{after}} tokens',
    }));
    if (pre > 0) {
      const freed = Math.max(0, Math.min(100, Math.round(((pre - post) / pre) * 100)));
      parts.push(t('chat.compactSummary.freedPercent', {
        percent: freed,
        defaultValue: '{{percent}}% freed',
      }));
    }
  } else if (post !== undefined) {
    parts.push(t('chat.compactSummary.tokensAfter', {
      after: formatCompactTokens(post),
      defaultValue: '{{after}} tokens',
    }));
  }

  if (typeof meta.durationMs === 'number' && meta.durationMs > 0) {
    parts.push(t('chat.compactSummary.duration', {
      duration: formatCompactionDuration(meta.durationMs),
      defaultValue: 'took {{duration}}',
    }));
  }

  return parts;
}

/**
 * One glyph set for every compaction state: same 13px box, 1.4px stroke.
 * `alert` marks a failed compaction, `auto` an engine-triggered one.
 */
function CompactionIcon({ kind }: { kind: 'archive' | 'auto' | 'alert' }) {
  if (kind === 'alert') {
    return (
      <svg
        className="compact-divider__icon"
        width="13" height="13" viewBox="0 0 16 16"
        fill="none" stroke="currentColor" strokeWidth={1.4}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.8v3.9M8 11.1v.1" />
      </svg>
    );
  }
  if (kind === 'auto') {
    return (
      <svg
        className="compact-divider__icon"
        width="13" height="13" viewBox="0 0 16 16"
        fill="none" stroke="currentColor" strokeWidth={1.4}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <path d="M8 1.9l1.4 4 4 1.4-4 1.4L8 12.7 6.6 8.7l-4-1.4 4-1.4z" />
      </svg>
    );
  }
  return (
    <svg
      className="compact-divider__icon"
      width="13" height="13" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <rect x="2" y="2.8" width="12" height="3" rx="1" />
      <path d="M3.3 5.8v6.2a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2V5.8" />
      <path d="M6.5 8.6h3" />
    </svg>
  );
}

/** Running state: an arc in the same 13px/1.4px box as the other icons. */
function CompactionSpinner() {
  return (
    <svg
      className="compact-divider__spinner"
      width="13" height="13" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.4" strokeOpacity={0.22} />
      <path d="M8 2.6a5.4 5.4 0 0 1 5.4 5.4" />
    </svg>
  );
}

interface CompactSummaryBlockProps {
  block: {
    type: 'compact_summary';
    title: string;
    content: string;
    metadata?: CompactSummaryMetadata;
    compactStatus?: 'in_progress' | 'success' | 'failure';
    startTime?: number;
  };
  t: TFunction;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Compaction is a boundary in the transcript, not a message: a hairline split
 * by a small capsule. Memoized so the elapsed timer and expansion survive the
 * frequent re-renders of a streaming neighbour.
 * `block.title` is an i18n key resolved via t() at render time.
 */
const CompactSummaryBlock = memo(function CompactSummaryBlock({ block, t }: CompactSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
  }, []);

  const toggleExpanded = useCallback(() => {
    if (!block.content) return;
    setExpanded(prev => !prev);
  }, [block.content]);

  const handleCopy = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!block.content) return;
    void copyToClipboard(block.content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  }, [block.content]);

  const isInProgress = block.compactStatus === 'in_progress';
  const isFailure = block.compactStatus === 'failure';
  const trigger = block.metadata?.trigger;
  const isAuto = trigger === 'auto';
  const isManual = trigger === 'manual';

  const [elapsedSeconds, setElapsedSeconds] = useState(() => (
    block.startTime ? Math.max(0, Math.floor((Date.now() - block.startTime) / 1000)) : 0
  ));

  useEffect(() => {
    if (!isInProgress) return;
    const timer = setInterval(() => {
      if (block.startTime) {
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - block.startTime) / 1000)));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isInProgress, block.startTime]);

  if (isInProgress) {
    return (
      <div className="compact-divider-block">
        <div className="compact-divider" role="status" aria-live="polite">
          <span className="compact-divider__line" aria-hidden="true" />
          <span className="compact-divider__chip">
            <CompactionSpinner />
            <span className="compact-divider__title">
              {isManual
                ? t('chat.manualCompacting', '正在压缩会话上下文...')
                : t('chat.autoCompacting', '正在自动压缩会话上下文...')}
            </span>
            <span className="compact-divider__time">{formatElapsed(elapsedSeconds)}</span>
          </span>
          <span className="compact-divider__line compact-divider__line--right" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (isFailure) {
    return (
      <div className="compact-divider-block">
        <div className="compact-divider">
          <span className="compact-divider__line" aria-hidden="true" />
          <span
            className="compact-divider__chip compact-divider__chip--fail"
            title={block.content || undefined}
          >
            <CompactionIcon kind="alert" />
            <span className="compact-divider__title">{t('chat.compactFailed')}</span>
            {block.content && (
              <span className="compact-divider__error">{block.content}</span>
            )}
          </span>
          <span className="compact-divider__line compact-divider__line--right" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const hasContent = Boolean(block.content);
  const stats = block.metadata ? buildCompactionStats(block.metadata, t) : [];
  const toggleLabel = expanded
    ? t('chat.compactSummary.collapse')
    : t('chat.compactSummary.expand');
  const copyLabel = copied
    ? t('chat.compactSummary.copied', '已复制')
    : t('chat.compactSummary.copy', '复制');

  return (
    <div className="compact-divider-block">
      <div className="compact-divider">
        <span className="compact-divider__line" aria-hidden="true" />
        <button
          type="button"
          className={`compact-divider__chip${isAuto ? ' compact-divider__chip--auto' : ''}`}
          aria-expanded={hasContent ? expanded : undefined}
          aria-label={`${t(block.title)}${hasContent ? ` — ${toggleLabel}` : ''}`}
          onClick={toggleExpanded}
          disabled={!hasContent}
        >
          <CompactionIcon kind={isAuto ? 'auto' : 'archive'} />
          <span className="compact-divider__title">{t(block.title)}</span>
          {stats.map((stat, index) => (
            <span key={`${index}-${stat}`} className="compact-divider__meta">
              {index > 0 && <span className="compact-divider__sep" aria-hidden="true">· </span>}
              {stat}
            </span>
          ))}
          {hasContent && (
            <span
              className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} compact-divider__chevron`}
              aria-hidden="true"
            />
          )}
        </button>
        <span className="compact-divider__line compact-divider__line--right" aria-hidden="true" />
      </div>
      {expanded && hasContent && (
        <div className="compact-divider__panel">
          <div className="compact-divider__panel-head">
            <span className="compact-divider__panel-label">
              {t('chat.compactSummary.summary', '摘要')}
            </span>
            <button
              type="button"
              className="compact-divider__copy"
              onClick={handleCopy}
              aria-label={copyLabel}
            >
              <span className="codicon codicon-copy compact-divider__copy-icon" aria-hidden="true" />
              <span>{copyLabel}</span>
            </button>
          </div>
          <div className="compact-divider__panel-body">
            <MarkdownBlock content={block.content} />
          </div>
        </div>
      )}
    </div>
  );
});

export interface ContentBlockRendererProps {
  block: ClaudeContentBlock;
  messageIndex: number;
  messageType: string;
  isStreaming: boolean;
  isThinkingExpanded: boolean;
  isThinking: boolean;
  isLastMessage: boolean;
  isLastBlock?: boolean;
  t: TFunction;
  onToggleThinking: () => void;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

export function ContentBlockRenderer({
  block,
  messageIndex,
  messageType,
  isStreaming,
  isThinkingExpanded,
  isThinking,
  isLastMessage,
  isLastBlock = false,
  t,
  onToggleThinking,
  findToolResult,
}: ContentBlockRendererProps): React.ReactElement | null {
  // `isStreaming` arriving here is message-level: it stays true for the whole
  // assistant turn, including tool round-trips and the wait for tool results.
  // But only the LAST block of a streaming message is still receiving tokens —
  // every earlier text/thinking block is already closed. Feeding those closed
  // blocks the full marked pipeline (instead of the lightweight streaming
  // renderer, which knows no tables/lists) lets block-level syntax render the
  // moment a later block such as a tool call arrives, instead of waiting for
  // the entire turn to end. The two renderers are height-aligned (breaks:
  // false), so switching between them stays invisible.
  const isActivelyStreaming = isStreaming && isLastBlock;

  // Subscribe to questionAnswerStore so that when setQuestionAnswer is called
  // (user answers a question), this component re-renders to display the card.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- hook order is stable
  useSyncExternalStore(subscribeQuestionAnswer, getQuestionAnswerSnapshot);

  if (block.type === 'text') {
    return messageType === 'user' ? (
      <CollapsibleTextBlock content={block.text ?? ''} />
    ) : (
      <MarkdownBlock
        content={block.text ?? ''}
        isStreaming={isActivelyStreaming}
      />
    );
  }

  if (block.type === 'image' && block.src) {
    const handleImagePreview = () => {
      const previewRoot = document.getElementById('image-preview-root');
      if (!previewRoot || !block.src) return;

      // Clear previous content safely
      previewRoot.innerHTML = '';

      // Create overlay container
      const overlay = document.createElement('div');
      overlay.className = 'image-preview-overlay';
      overlay.onclick = () => overlay.remove();

      // Create image element safely (prevents XSS)
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = t('chat.imagePreview');
      img.className = 'image-preview-content';
      img.onclick = (e) => e.stopPropagation();

      // Create close button
      const closeBtn = document.createElement('div');
      closeBtn.className = 'image-preview-close';
      closeBtn.textContent = '×';
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        overlay.remove();
      };

      overlay.appendChild(img);
      overlay.appendChild(closeBtn);
      previewRoot.appendChild(overlay);
    };

    return (
      <div
        className={`message-image-block ${messageType === 'user' ? 'user-image' : ''}`}
        onClick={handleImagePreview}
        style={IMAGE_BLOCK_STYLE}
        title={t('chat.clickToPreview')}
      >
        <img
          src={block.src}
          alt={t('chat.userUploadedImage')}
          style={getImageStyle(messageType === 'user')}
        />
      </div>
    );
  }

  if (block.type === 'attachment') {
    const rawName = block.fileName || (block as any).name || (block as any).title || (block as any).filename || '';
    const ext = getExtension(rawName);
    const displayName = rawName || t('chat.unknownFile');
    const mediaType = block.mediaType || (block as any).media_type || '';
    return (
      <div className="message-attachment-chip" title={displayName}>
        <span className={`message-attachment-chip-icon codicon ${getFileIcon(mediaType)}`} />
        {ext && <span className="message-attachment-chip-ext">{ext}</span>}
        <span className="message-attachment-chip-name">{displayName}</span>
      </div>
    );
  }

  if (block.type === 'thinking') {
    return (
      <div className="thinking-block">
        <div
          className="thinking-header"
          onClick={onToggleThinking}
        >
          <span className="thinking-title">
            {isThinking && isLastMessage && isLastBlock
              ? t('common.thinkingProcess')
              : t('common.thinking')}
          </span>
          <span className="thinking-icon">
            {isThinkingExpanded ? '▼' : '▶'}
          </span>
        </div>
        <div className={`thinking-content ${isThinkingExpanded ? 'expanded' : ''}`}>
          <div className="thinking-content-inner">
            <MarkdownBlock
              content={block.thinking ?? block.text ?? t('chat.noThinkingContent')}
              isStreaming={isActivelyStreaming}
            />
          </div>
        </div>
      </div>
    );
  }

  if (block.type === 'tool_use') {
    const toolName = normalizeToolName(block.name ?? '');
    console.log(`[ContentBlockRenderer] tool_use: name="${block.name}" normalized="${toolName}" id="${block.id}" isStreaming=${isStreaming}`);

    if (toolName === 'todowrite' || toolName === 'update_plan' || TASK_MANAGE_TOOL_NAMES.has(toolName)) {
      return null;
    }

    // Interactive tool calls — permission requests are handled by the
    // PermissionDialog popup; askuserquestion renders a read-only Q&A summary
    // inline in the flow. The answer comes from the host's onQuestionAnswered
    // bridge event (stored in questionAnswerStore), falling back to findToolResult.
    if (toolName === 'askuserquestion' || toolName === 'question') {
      const blockId = block.id ?? '';
      const storedQA = getQuestionAnswer(blockId);
      console.log(`[ContentBlockRenderer] askuserquestion blockId="${blockId}" storedQA=${!!storedQA} block.input.questions=${JSON.stringify(block.input?.questions ?? []).substring(0, 300)}`);
      let answerBlock: ToolResultBlock | null = null;
      let storedAnswers: Map<string, string> | undefined;
      if (storedQA) {
        const answerText = Object.entries(storedQA.answers)
          .map(([question, value]) => {
            const ans = Array.isArray(value) ? value.join(', ') : value;
            return `${question}\n${ans}`;
          })
          .join('\n\n');
        answerBlock = { type: 'tool_result', tool_use_id: blockId, content: answerText };
        // Build the structured answers map at the source of truth, so the
        // card never has to re-parse our own synthetic content string.
        storedAnswers = new Map<string, string>();
        for (const [question, value] of Object.entries(storedQA.answers)) {
          const ans = Array.isArray(value) ? value.join(', ') : value;
          storedAnswers.set(question, ans);
        }
        console.log(`[ContentBlockRenderer] askuserquestion using storedQA, answerText=${answerText.substring(0, 200)}`);
      } else {
        answerBlock = findToolResult(blockId, messageIndex) ?? null;
        console.log(`[ContentBlockRenderer] askuserquestion fallback findToolResult blockId="${blockId}" found=${!!answerBlock}`);
      }
      // Resolve the card lifecycle status from the tool_result shape:
      //   1. opencode flagged the tool as errored (rejectQuestion → failTool
      //      "question rejected")  → 'cancelled'. We can't distinguish user
      //      skip from daemon-side timeout (same `failTool` path), so both
      //      render as "已取消" per the agreed fallback.
      //   2. parsed `"q"="a"` pairs present                → 'answered'
      //   3. otherwise (no tool_result yet, or empty text) → 'unanswered'
      //
      // opencode's `failTool(state, ask.ref, "question rejected")` writes that
      // exact string into `state.error`, which the bridge emits as the
      // tool_result's content. We fall back on that literal so the cancelled
      // badge shows even if the `is_error` flag is missing on the wire (older
      // daemon builds, partial messages, etc.).
      const answerBlockText = answerBlock
        ? (typeof answerBlock.content === 'string'
            ? answerBlock.content
            : Array.isArray(answerBlock.content)
              ? answerBlock.content
                  .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
                  .filter(Boolean)
                  .join('\n')
              : '')
        : '';
      const isCancelled = answerBlock?.is_error === true
        || answerBlockText.includes('question rejected');
      // Count real answer pairs. storedQA (from the host's onQuestionAnswered
      // callback) is the structured source of truth and wins over the parser;
      // otherwise we count `"q"="a"` pairs in the opencode wire format, with
      // a storedQA-flavoured "question\nanswer" round-trip fallback so the
      // card never falsely reports "未回答" when the user actually replied.
      const parsedAnswerCount = (() => {
        if (storedAnswers && storedAnswers.size > 0) return storedAnswers.size;
        const map = new Map<string, string>();
        const regex = /"([^"]+)"\s*=\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(answerBlockText)) !== null) {
          map.set(m[1], m[2]);
        }
        if (map.size > 0) return map.size;
        for (const pair of answerBlockText.split(/\n\n+/)) {
          const newlineIdx = pair.indexOf('\n');
          if (newlineIdx <= 0) continue;
          const q = pair.slice(0, newlineIdx).trim();
          const a = pair.slice(newlineIdx + 1).trim();
          if (q && a) map.set(q, a);
        }
        return map.size;
      })();
      const status: 'answered' | 'cancelled' | 'unanswered' = isCancelled
        ? 'cancelled'
        : parsedAnswerCount > 0
          ? 'answered'
          : 'unanswered';
      return (
        <QuestionAnswerSummary
          questions={
            ((block.input?.questions as QuestionSummaryItem[] | undefined)
              ?? storedQA?.questions
              ?? []) as QuestionSummaryItem[]
          }
          answer={answerBlock}
          answers={storedAnswers}
          status={status}
          t={t}
        />
      );
    }
    if (toolName === 'requestpermissions') {
      return null;
    }

    if (!isStreaming && isTransientInternalToolName(block.name)) {
      return null;
    }

    if (AGENT_TOOL_NAMES.has(toolName)) {
      return (
        <TaskExecutionBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
          isStreaming={isStreaming}
        />
      );
    }

    if (isToolName(block.name, EDIT_TOOL_NAMES)) {
      return (
        <SingleEditToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    if (isToolName(block.name, BASH_TOOL_NAMES)) {
      return (
        <BashToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    return (
      <GenericToolBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  // Compact summary block - collapsed by default, click to expand
  if (block.type === 'compact_summary') {
    return <CompactSummaryBlock block={block} t={t} />;
  }

  // Task notification block - renders as "● summary" with status color
  if (block.type === 'task_notification') {
    // TypeScript narrows block to { type: 'task_notification'; icon; summary; status; detail? }
    const statusColor = TASK_STATUS_COLORS[block.status] || 'text';
    const detail = block.detail;
    const truncatedDetail = detail && detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
    return (
      <div className={`task-notification-block task-notification-${statusColor}`}>
        <span className="task-notification-icon">{block.icon}</span>
        <span className="task-notification-summary">
          {block.summary}
          {truncatedDetail && (
            <span className="task-notification-detail" title={detail}>{truncatedDetail}</span>
          )}
        </span>
      </div>
    );
  }

  return null;
}
