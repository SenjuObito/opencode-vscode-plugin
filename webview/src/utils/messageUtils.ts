import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage, CompactSummaryMetadata } from '../types';
import {
  containsAnyTag,
  createTaskNotificationBlock,
  extractCommandMessageContent,
  formatCommandForDisplay,
  formatTaskNotificationForDisplay,
  hasCommandMessageTag,
  hasTaskNotificationTag,
  isPlaceholderMessageContent,
  isSyntheticToolMessageContent,
  HIDDEN_OUTPUT_TAGS,
  INTERNAL_METADATA_TAGS,
  MESSAGE_TYPES,
  ORIGIN_KINDS,
  type LocalizeMessageFn,
} from './contentBlockNormalize';
import { MESSAGE_MERGE_CACHE_LIMIT } from './messageMergeCache';
import { clearStaleStreamEndedMarker, hasRecentlyEndedTurnId } from './streamMarkers';
import { isToolResultOnlyUserMessage } from './turnScope';

// ---------------------------------------------------------------------------
// Re-exports — keep messageUtils.ts as the public barrel so existing imports
// (from hooks, components, tests) keep working.
// ---------------------------------------------------------------------------

export {
  MESSAGE_TYPES,
  ORIGIN_KINDS,
  HIDDEN_OUTPUT_TAGS,
  INTERNAL_METADATA_TAGS,
  FILTERED_NORMALIZE_TAGS,
  TASK_STATUS_COLORS,
  containsAnyTag,
  hasCommandMessageTag,
  formatCommandForDisplay,
  formatCommandForResubmit,
  hasTaskNotificationTag,
  formatTaskNotificationForDisplay,
  createTaskNotificationBlock,
  extractCommandMessageContent,
  isPlaceholderMessageContent,
  isSyntheticToolMessageContent,
  normalizeBlocks,
} from './contentBlockNormalize';
export type { LocalizeMessageFn } from './contentBlockNormalize';

/**
 * Generate a stable key for a message, used for React list keys and anchor navigation.
 * Prefer raw.uuid > __turnId > type-timestamp > fallback to type-index.
 */
export function getMessageKey(message: ClaudeMessage, index: number): string {
  const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
  if (typeof rawObj?.uuid === 'string' && rawObj.uuid) return rawObj.uuid;
  if (message.__turnId !== undefined) return `turn-${message.__turnId}`;
  return message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${index}`;
}

interface MessageKeyRecord {
  message: ClaudeMessage;
  key: string;
  aliases: string[];
}

export interface MessageKeySnapshot {
  scope: string;
  keys: string[];
  records: MessageKeyRecord[];
}

function getMessageKeyAliases(message: ClaudeMessage): string[] {
  const aliases: string[] = [];
  const rawObj = typeof message.raw === 'object' && message.raw !== null
    ? message.raw as Record<string, unknown>
    : null;
  if (typeof rawObj?.uuid === 'string' && rawObj.uuid) aliases.push(`uuid:${rawObj.uuid}`);
  if (typeof message.__turnId === 'number') aliases.push(`turn:${message.__turnId}`);
  if (typeof message.id === 'string' && message.id) aliases.push(`id:${message.id}`);
  if (message.timestamp !== undefined && message.timestamp !== null && message.timestamp !== '') {
    aliases.push(`timestamp:${message.type}:${message.timestamp}`);
  }
  return aliases;
}

/**
 * Reconcile one unique message key per array item while retaining keys across
 * streaming identity enrichment and history prepends. The returned snapshot is
 * shared by MessageList and MessageAnchorRail so DOM registration and anchor
 * navigation always use the same identifiers.
 */
export function reconcileMessageKeys(
  messages: ClaudeMessage[],
  previous: MessageKeySnapshot | undefined,
  scope: string,
): MessageKeySnapshot {
  const reusablePrevious = previous?.scope === scope ? previous : undefined;
  const records: MessageKeyRecord[] = messages.map((message) => ({
    message,
    key: '',
    aliases: getMessageKeyAliases(message),
  }));
  const usedPreviousRecords = new Set<MessageKeyRecord>();
  const usedKeys = new Set<string>();

  if (reusablePrevious) {
    const previousByMessage = new Map<ClaudeMessage, MessageKeyRecord[]>();
    for (const record of reusablePrevious.records) {
      const candidates = previousByMessage.get(record.message) ?? [];
      candidates.push(record);
      previousByMessage.set(record.message, candidates);
    }
    for (const record of records) {
      const matched = previousByMessage.get(record.message)
        ?.find((candidate) => !usedPreviousRecords.has(candidate));
      if (!matched) continue;
      record.key = matched.key;
      usedPreviousRecords.add(matched);
      usedKeys.add(matched.key);
    }

    const previousByAlias = new Map<string, MessageKeyRecord[]>();
    for (const record of reusablePrevious.records) {
      if (usedPreviousRecords.has(record)) continue;
      for (const alias of record.aliases) {
        const candidates = previousByAlias.get(alias) ?? [];
        candidates.push(record);
        previousByAlias.set(alias, candidates);
      }
    }
    for (const aliasPrefix of ['uuid:', 'turn:', 'id:', 'timestamp:']) {
      for (const record of records) {
        if (record.key) continue;
        const aliases = record.aliases.filter((alias) => alias.startsWith(aliasPrefix));
        const matched = aliases
          .flatMap((alias) => previousByAlias.get(alias) ?? [])
          .find((candidate) => !usedPreviousRecords.has(candidate));
        if (!matched) continue;
        record.key = matched.key;
        usedPreviousRecords.add(matched);
        usedKeys.add(matched.key);
      }
    }
  }

  records.forEach((record, index) => {
    if (record.key) return;
    const base = `${scope}:${getMessageKey(record.message, index)}`;
    let key = base;
    let occurrence = 1;
    while (usedKeys.has(key)) {
      key = `${base}-${occurrence}`;
      occurrence += 1;
    }
    record.key = key;
    usedKeys.add(key);
  });

  return { scope, keys: records.map((record) => record.key), records };
}

// ---------------------------------------------------------------------------
// Type guards - safer than type assertions
// ---------------------------------------------------------------------------

/**
 * Type guard: check if raw message has valid origin field
 */
function hasOriginField(raw: unknown): raw is { origin: { kind: string } } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const origin = r.origin;
  if (!origin || typeof origin !== 'object') return false;
  const o = origin as Record<string, unknown>;
  return typeof o.kind === 'string';
}

/**
 * Whether a user row is a real human prompt rather than a tool_result carrier
 * or a synthetic/task-notification row. The anchor rail and pagination both
 * need this so tool plumbing never becomes a navigation anchor.
 */
export function isHumanUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if (isToolResultOnlyUserMessage(message)) return false;

  const raw = typeof message.raw === 'object' && message.raw !== null
    ? (message.raw as Record<string, unknown>)
    : null;
  if (raw?.synthetic === true) return false;

  const contentStr = typeof message.content === 'string' ? message.content : '';
  if (contentStr === '[tool_result]' || contentStr.includes('<task-notification>')) return false;

  const nestedMessage = raw?.message && typeof raw.message === 'object'
    ? (raw.message as Record<string, unknown>)
    : undefined;
  const rawContent = raw?.content ?? nestedMessage?.content;
  if (Array.isArray(rawContent)) {
    if (rawContent.length === 0) return Boolean(contentStr.trim());
    return rawContent.some((block) => {
      if (!block || typeof block !== 'object') return false;
      return (block as { type?: string }).type !== 'tool_result';
    });
  }
  return true;
}

/**
 * Check if a message has non-human origin (should be rendered as system notification, not user message).
 * CLI uses origin.kind to distinguish synthetic messages from human input.
 */
export function hasNonHumanOrigin(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;

  const raw = message.raw;
  if (!hasOriginField(raw)) return false;

  // If origin.kind exists and is not 'human', this is a synthetic message
  return raw.origin.kind !== ORIGIN_KINDS.HUMAN;
}

/**
 * Whether a message carries the given opencode message id.
 *
 * opencode's id is stamped in different places depending on provenance: the
 * live/history converter writes it to `raw.id`, rewind-patched user messages
 * surface it as `raw.uuid`, and some paths copy it to the top level. All three
 * spellings are checked, so an id arriving from a server event matches the
 * message however it was recorded.
 */
export function matchesProviderMessageId(message: ClaudeMessage | undefined | null, id: string): boolean {
  if (!message || !id) return false;
  if (typeof message.id === 'string' && message.id === id) return true;
  const raw = message.raw as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object') {
    if (typeof raw.id === 'string' && raw.id === id) return true;
    if (typeof raw.uuid === 'string' && raw.uuid === id) return true;
  }
  return false;
}

/**
 * Drop messages whose opencode id is in `ids` (the reverted/removed set).
 *
 * This is the view-layer half of the revert-cleanup fix: when the host replays
 * the server's `message.removed` events it calls `window.onMessagesRemoved`, and
 * the list must shrink locally *before* the next full snapshot arrives — otherwise
 * `preserveLatestMessagesOnShrink` would rescue the voided tail back into view.
 *
 * Returns the same array reference when nothing matched, so callers can keep the
 * previous render when the diff is empty.
 */
export function applyMessagesRemoved(messages: ClaudeMessage[], ids: string[]): ClaudeMessage[] {
  if (!ids.length) return messages;
  const next = messages.filter((m) => !ids.some((id) => matchesProviderMessageId(m, id)));
  return next.length === messages.length ? messages : next;
}

/**
 * Extract all text strings from a raw message's content (handles various structures).
 * Shared helper to avoid duplicating traversal logic.
 */
function extractTextsFromRaw(raw: ClaudeRawMessage | string | undefined): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const texts: string[] = [];
  const extractFromContent = (content: unknown) => {
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          }
        }
      }
    }
  };
  const rawObj = raw as Record<string, unknown>;
  extractFromContent(rawObj.content);
  if (rawObj.message && typeof rawObj.message === 'object') {
    extractFromContent((rawObj.message as Record<string, unknown>).content);
  }
  return texts;
}

/**
 * Check if a message is a task_notification only message (should be rendered as system notification, not user message).
 * This is used to change message type from 'user' to 'task_notification' for proper rendering.
 */
export function isTaskNotificationOnlyMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;

  // Check raw content structures for task-notification tag
  const rawTexts = extractTextsFromRaw(message.raw);
  if (rawTexts.some(hasTaskNotificationTag)) return true;

  // Fallback: check message.content (may differ from raw when set independently)
  return typeof message.content === 'string' && hasTaskNotificationTag(message.content);
}

/**
 * Get text content from a message
 */
export function getMessageText(
  message: ClaudeMessage,
  localizeMessage: LocalizeMessageFn,
  t: TFunction
): string {
  let text = '';

  if (message.content) {
    text = message.content;
  } else {
    const raw = message.raw;
    if (!raw) {
      return `(${t('chat.emptyMessage')})`;
    }
    if (typeof raw === 'string') {
      text = raw;
    } else if (typeof raw.content === 'string') {
      text = raw.content;
    } else if (Array.isArray(raw.content)) {
      text = raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else if (raw.message?.content && Array.isArray(raw.message.content)) {
      text = raw.message.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else {
      return `(${t('chat.emptyMessage')})`;
    }
  }

  // Apply localization
  let result = localizeMessage(text);

  // Format <command-message> content using formatCommandForDisplay
  // Only apply to user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && hasCommandMessageTag(result)) {
    const displayContent = formatCommandForDisplay(result);
    if (displayContent) {
      result = displayContent;
    } else {
      // Fallback to old extraction
      result = extractCommandMessageContent(result);
    }
  }

  // Format <task-notification> for copy/resubmit purposes
  if (hasTaskNotificationTag(result)) {
    const notification = formatTaskNotificationForDisplay(result);
    if (notification) {
      result = `${notification.icon} ${notification.summary}`;
    }
  }

  return result;
}

/**
 * Determine if a message should be shown in the UI
 */
export function shouldShowMessage(
  message: ClaudeMessage,
  getMessageTextFn: (msg: ClaudeMessage) => string,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  t: TFunction
): boolean {
  // Filter isMeta messages (like "Caveat: The messages below were generated...")
  // CLI: isMeta messages are hidden in normal transcript (except channel messages)
  if (message.raw && typeof message.raw === 'object' && 'isMeta' in message.raw && message.raw.isMeta === true) {
    return false;
  }

  // Note: origin.kind filtering is ONLY for title extraction (extractTitleText, sessionTitle),
  // NOT for hiding messages in the main chat. CLI displays these messages with different formats.
  // See CLI's wrapCommandText() and isVisibleInTranscript() functions.

  // Filter toolUseResult and isCompactSummary messages (CLI filters these in extractTitleText)
  if (message.raw && typeof message.raw === 'object') {
    if ('toolUseResult' in message.raw && message.raw.toolUseResult) {
      return false;
    }
    if ('isCompactSummary' in message.raw && message.raw.isCompactSummary) {
      return false;
    }
  }

  // Filter command messages (containing <command-name> or <local-command-stdout> tags)
  // BUT allow <command-message> tags - they will be processed to show only inner content

  // Get raw text content for tag checking (before extraction)
  const getRawTextContent = (): string => {
    if (message.content) return message.content;
    const raw = message.raw;
    if (!raw) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw.content === 'string') return raw.content;
    if (Array.isArray(raw.content)) {
      return raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    }
    if (raw.message?.content) {
      if (typeof raw.message.content === 'string') return raw.message.content;
      if (Array.isArray(raw.message.content)) {
        return raw.message.content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
      }
    }
    return '';
  };

  const rawText = getRawTextContent();

  // CLI renders these messages with specific components:
  // - <command-message> → UserCommandMessage (skill/slash command)
  // - <local-command-stdout/stderr> → UserLocalCommandOutputMessage
  // - <task-notification> → UserAgentNotificationMessage
  // - Plain text (like "Unknown skill: xxx") → UserPromptMessage (displayed with ❯ prefix)
  // So we should NOT filter these messages, just handle their rendering.

  // If message has <command-message>, allow it to be shown
  // (the content will be extracted by formatCommandForDisplay)
  if (rawText && hasCommandMessageTag(rawText)) {
    return true;
  }

  // Messages with <local-command-stdout> or <local-command-stderr> should be shown
  // CLI renders them with UserLocalCommandOutputMessage component
  // But for GUI, we filter these as they are internal terminal output
  // Only filter for user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && rawText && containsAnyTag(rawText, HIDDEN_OUTPUT_TAGS)) {
    return false;
  }

  // Filter messages with command tags (internal metadata, not user input)
  // BUT keep "Unknown skill: xxx" messages which are plain text user-visible messages
  // Only filter for user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && rawText && containsAnyTag(rawText, INTERNAL_METADATA_TAGS)) {
    return false;
  }

  // Task-notification messages are always shown — normalizeBlocks converts them
  // to task_notification blocks, no need to re-parse here (performance optimization).
  if (rawText && hasTaskNotificationTag(rawText)) {
    return true;
  }

  const text = getMessageTextFn(message);
  if (message.type === 'user' && text === '[tool_result]') {
    return false;
  }
  if (message.type === 'assistant') {
    return true;
  }
  if (message.type === 'user' || message.type === 'error') {
    // Check if there's valid text content
    if (text && text.trim() && text !== `(${t('chat.emptyMessage')})` && text !== `(${t('chat.parseError')})`) {
      return true;
    }
    // Check if there are valid content blocks (like images)
    const rawBlocks = normalizeBlocksFn(message.raw);
    if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
      // Ensure at least one non-empty content block
      const hasValidBlock = rawBlocks.some(block => {
        if (block.type === 'text') {
          return block.text && block.text.trim().length > 0;
        }
        if (block.type === 'task_notification') {
          return block.summary && block.summary.trim().length > 0;
        }
        // Images, tool_use and other block types should be shown
        return true;
      });
      return hasValidBlock;
    }
    return false;
  }
  return true;
}

/**
 * Get content blocks from a message for rendering
 */
export function getContentBlocks(
  message: ClaudeMessage,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  localizeMessage: LocalizeMessageFn
): ClaudeContentBlock[] {
  // Host-owned compaction record: one card, three states. The host is the only
  // producer (live and history), so the view never synthesizes a second one.
  if (message.type === MESSAGE_TYPES.COMPACTION) {
    const meta = message.compaction;
    const compactStatus: 'in_progress' | 'success' | 'failure' =
      meta?.status === 'failed'
        ? 'failure'
        : (meta?.status === 'in_progress' ? 'in_progress' : 'success');
    const content = compactStatus === 'failure'
      ? (meta?.error ?? message.content ?? '')
      : (message.content ?? '');
    const tokens = meta?.tokens ?? {};
    const total = typeof tokens.total === 'number'
      ? tokens.total
      : (typeof tokens.input === 'number' ? tokens.input : undefined);
    const metadata: CompactSummaryMetadata = {
      ...(meta?.reason ? { trigger: meta.reason } : {}),
      ...(typeof total === 'number' ? { postTokens: total } : {}),
      ...(typeof meta?.durationMs === 'number' ? { durationMs: meta.durationMs } : {}),
    };
    return [{
      type: 'compact_summary',
      title: compactStatus === 'failure' ? 'chat.compactFailed' : 'chat.compactSummary.compacted',
      content,
      compactStatus,
      startTime: meta?.startedAt,
      metadata,
    }];
  }

  const rawBlocks = normalizeBlocksFn(message.raw);
  if (rawBlocks && rawBlocks.length > 0) {
    // Don't add message.content if we have task_notification blocks
    // (those are formatted from the raw XML content).
    // Note: command-message text blocks are already formatted by normalizeBlocks
    // (e.g., "/opsx:ff hello") and no longer contain raw XML tags.
    const hasSpecialBlock = rawBlocks.some((block) => block.type === 'task_notification');
    if (hasSpecialBlock) {
      return rawBlocks;
    }
    // Streaming/tool scenario: if raw doesn't have text but message.content has text, still need to show text
    const hasTextBlock = rawBlocks.some(
      (block) => block.type === 'text' && typeof block.text === 'string' && String(block.text).trim().length > 0,
    );
    if (
      !hasTextBlock &&
      message.content &&
      message.content.trim() &&
      !isSyntheticToolMessageContent(message.content, rawBlocks) &&
      !isPlaceholderMessageContent(message.content)
    ) {
      return [...rawBlocks, { type: 'text', text: localizeMessage(message.content) }];
    }
    return rawBlocks;
  }
  // If no raw blocks, check if content needs special handling
  if (message.content && message.content.trim()) {
    // Handle task-notification in message.content directly
    if (hasTaskNotificationTag(message.content)) {
      const block = createTaskNotificationBlock(message.content);
      if (block) return [block];
    }
    // Handle command-message in message.content directly
    if (hasCommandMessageTag(message.content)) {
      const displayContent = formatCommandForDisplay(message.content);
      if (displayContent) {
        return [{ type: 'text' as const, text: localizeMessage(displayContent) }];
      }
    }
    return [{ type: 'text', text: localizeMessage(message.content) }];
  }
  // If no content at all, return empty array instead of showing "(empty message)"
  // shouldShowMessage will filter out these messages
  return [];
}

/**
 * Merge consecutive assistant messages to fix style inconsistencies in history
 * where Thinking and ToolUse are separated.
 */
export function mergeConsecutiveAssistantMessages(
  messages: ClaudeMessage[],
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  cache?: Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>
): ClaudeMessage[] {
  if (messages.length === 0) return [];

  // Clear stale stream-ended markers once at entry (5 second timeout)
  clearStaleStreamEndedMarker();

  const getStableId = (message: ClaudeMessage, index: number): string => {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    const uuid = rawObj?.uuid;
    if (typeof uuid === 'string' && uuid) return uuid;
    if (message.timestamp) return `${message.type}-${message.timestamp}`;
    return `${message.type}-${index}`;
  };

  const getAssistantBlockSummary = (message: ClaudeMessage): { hasToolUse: boolean; hasText: boolean } => {
    const blocks = normalizeBlocksFn(message.raw) || [];
    return {
      hasToolUse: blocks.some((block) => block.type === 'tool_use'),
      hasText: blocks.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
        || Boolean(message.content && message.content.trim()),
    };
  };

  const shouldMergeAssistantMessage = (previous: ClaudeMessage, next: ClaudeMessage): boolean => {
    // Distinct streaming turns must stay visually separated even when the
    // backend emits adjacent assistant fragments during synchronization.
    // Block merge when either side has a __turnId and they differ.
    // This prevents streaming messages from merging with history messages.
    // FIX: Also check __lastStreamEndedTurnId to distinguish recently-ended
    // streaming messages from true history messages.
    const prevTurnId = previous.__turnId;
    const nextTurnId = next.__turnId;

    // If either message has the recently-ended turn ID, block merging
    if (hasRecentlyEndedTurnId(prevTurnId) || hasRecentlyEndedTurnId(nextTurnId)) {
      return false;
    }

    // Block merge when either side has a __turnId and they differ
    if ((prevTurnId !== undefined || nextTurnId !== undefined) &&
        prevTurnId !== nextTurnId) {
      return false;
    }

    const previousSummary = getAssistantBlockSummary(previous);
    const nextSummary = getAssistantBlockSummary(next);

    // For messages without __turnId (loaded from history), allow merging across
    // tool_use boundary so that tool-execution and final answer appear as one block.
    // For streaming messages (with __turnId), keep tool_use separated from answer.
    const bothLackTurnId = prevTurnId === undefined && nextTurnId === undefined;
    if (!bothLackTurnId && previousSummary.hasToolUse !== nextSummary.hasToolUse) {
      return false;
    }

    return true;
  };

  const isToolResultOnlyUserMessage = (message: ClaudeMessage): boolean => {
    if (message.type !== 'user') {
      return false;
    }

    if ((message.content ?? '').trim() === '[tool_result]') {
      return true;
    }

    const raw = message.raw;
    if (!raw || typeof raw === 'string') {
      return false;
    }

    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return false;
    }

    return content.every((block) => block && block.type === 'tool_result');
  };

  const buildMergedAssistantMessage = (group: ClaudeMessage[]): ClaudeMessage => {
    const first = group[0];

    const combinedBlocks: ClaudeContentBlock[] = [];
    const contentParts: string[] = [];

    for (const msg of group) {
      const blocks = normalizeBlocksFn(msg.raw) || [];
      if (blocks.length > 0) {
        combinedBlocks.push(...blocks);
      }
      if (msg.content) {
        const trimmed = msg.content.trim();
        if (trimmed && !isPlaceholderMessageContent(msg.content)) {
          contentParts.push(msg.content);
        }
      }
    }

    const rawBase: ClaudeRawMessage =
      (typeof first.raw === 'object' && first.raw ? { ...(first.raw as ClaudeRawMessage) } : ({} as ClaudeRawMessage));

    const nextRaw: ClaudeRawMessage = {
      ...rawBase,
      content: combinedBlocks,
      message: rawBase.message ? { ...rawBase.message, content: combinedBlocks } : rawBase.message,
    };

    const mergedContent = contentParts.join('\n');

    return {
      ...first,
      content: mergedContent,
      raw: nextRaw,
      __turnId: first.__turnId,
    };
  };

  const result: ClaudeMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type !== 'assistant') {
      result.push(msg);
      i += 1;
      continue;
    }

    const assistantGroup: ClaudeMessage[] = [msg];
    let j = i + 1;
    let previousAssistant = msg;

    while (j < messages.length) {
      const candidate = messages[j];

      if (isToolResultOnlyUserMessage(candidate)) {
        j += 1;
        continue;
      }

      if (candidate.type === 'assistant' && shouldMergeAssistantMessage(previousAssistant, candidate)) {
        assistantGroup.push(candidate);
        previousAssistant = candidate;
        j += 1;
        continue;
      }

      break;
    }

    const group = messages.slice(i, j);
    if (assistantGroup.length <= 1) {
      result.push(msg);
      i = j;
      continue;
    }

    const groupKey = `${getStableId(group[0], i)}..${getStableId(group[group.length - 1], j - 1)}#${group.length}`;

    if (cache) {
      const cached = cache.get(groupKey);
      if (
        cached &&
        cached.source.length === group.length &&
        cached.source.every((m, idx) => m === group[idx])
      ) {
        result.push(cached.merged);
        i = j;
        continue;
      }
    }

    const merged = buildMergedAssistantMessage(assistantGroup);
    if (cache) {
      cache.set(groupKey, { source: group, merged });
      if (cache.size > MESSAGE_MERGE_CACHE_LIMIT) {
        cache.clear();
      }
    }
    result.push(merged);
    i = j;
  }

  return result;
}
