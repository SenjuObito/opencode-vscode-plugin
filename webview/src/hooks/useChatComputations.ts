import { type RefObject, useCallback, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import { cardDebugLog } from '../utils/bridge';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  SubagentHistoryResponse,
  TodoItem,
  ToolResultBlock,
} from '../types';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';
import {
  containsAnyTag,
  hasTaskNotificationTag,
  INTERNAL_METADATA_TAGS,
} from '../utils/messageUtils';
import { extractTodosFromToolUse, extractAccumulatedTasks } from '../utils/todoToolNormalization';
import {
  computeStatusScopeMessages,
  finalizeSubagentsForSettledTurn,
  finalizeTodosForSettledTurn,
  sliceLatestConversationTurn,
} from '../utils/turnScope';
import { extractSubagentsFromMessages, useSubagents } from './useSubagents';
import { useFileChanges } from './useFileChanges';
import { useFileChangesManagement } from './useFileChangesManagement';
import type { useMessageProcessing } from './useMessageProcessing';

interface UseChatComputationsParams {
  t: TFunction;
  messages: ClaudeMessage[];
  mergedMessages: ClaudeMessage[];
  subagentHistories: Record<string, SubagentHistoryResponse>;
  customSessionTitle: string | null;
  streamingActive: boolean;
  currentProvider: string;
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  getMessageText: ReturnType<typeof useMessageProcessing>['getMessageText'];
  getContentBlocks: ReturnType<typeof useMessageProcessing>['getContentBlocks'];
  /** Authoritative todo list from opencode's `todo.updated` SSE event. */
  sseTodos: TodoItem[] | null;
}

/**
 * Whether a message slice contains any assistant tool_use block. Used to decide
 * whether the latest-turn scope is carrying active tool work worth focusing on,
 * or is empty of tools (a reload snapshot / text-only turn) and should widen to
 * the full conversation so StatusPanel lists do not disappear.
 */
function sliceHasToolUse(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const blocks = getContentBlocks(message);
    for (const block of blocks) {
      if (block.type === 'tool_use') return true;
    }
  }
  return false;
}

export function deriveTodosForTurn(
  turnMessages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  streamingActive: boolean,
): TodoItem[] {
  let latestTodos: ReturnType<typeof extractTodosFromToolUse> = null;
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const msg = turnMessages[i];
    if (msg.type !== 'assistant') continue;
    const blocks = getContentBlocks(msg);
    cardDebugLog('[deriveTodos] msg', i, 'type:', msg.type, 'blocks:', blocks.length, 'types:', blocks.map(b => b.type));
    for (let j = blocks.length - 1; j >= 0; j--) {
      const todos = extractTodosFromToolUse(blocks[j]);
      if (todos && todos.length > 0) {
        latestTodos = todos;
        break;
      }
    }
    if (latestTodos) break;
  }

  if (latestTodos) {
    return finalizeTodosForSettledTurn(latestTodos, streamingActive);
  }

  return extractAccumulatedTasks(turnMessages, getContentBlocks);
}

/**
 * Bundles all chat-view derived computations: tool result lookup table,
 * subagent extraction, todos, rewindable messages, file change filtering,
 * and session title.
 *
 * Stage 5 of TASK-P1-01 — moves ~120 lines of computation out of App.tsx.
 */
export function useChatComputations({
  t,
  messages,
  subagentHistories,
  customSessionTitle,
  streamingActive,
  currentSessionId,
  currentSessionIdRef,
  getMessageText,
  getContentBlocks,
  sseTodos,
}: UseChatComputationsParams) {
  // Ref-backed scan over messages for tool_result blocks, with a per-id cache.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolResultRawMapRef = useRef<Map<string, ClaudeRawMessage>>(new Map());

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') return null;
    const currentMessages = messagesRef.current;
    const cachedRaw = toolResultRawMapRef.current.get(toolUseId);
    if (cachedRaw != null) {
      const content = cachedRaw.content ?? cachedRaw.message?.content;
      if (Array.isArray(content)) {
        const hit = content.find(
          (block): block is ToolResultBlock =>
            Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
        );
        if (hit) return hit;
      }
    }
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = raw.content ?? raw.message?.content;
      if (!Array.isArray(content)) continue;
      const resultBlock = content.find(
        (block): block is ToolResultBlock =>
          Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
      );
      if (resultBlock) {
        toolResultRawMapRef.current.set(toolUseId, raw);
        return resultBlock;
      }
    }
    return null;
  }, []);

  const getToolResultRaw = useCallback<GetToolResultRawFn>(
    (toolUseId: string) => toolResultRawMapRef.current.get(toolUseId) ?? null,
    [],
  );

  // File changes (depend on findToolResult which is now stable above).
  const fileChangeMgmt = useFileChangesManagement({
    currentSessionId, currentSessionIdRef, messages,
    getContentBlocks, findToolResult,
  });
  const fileChanges = useFileChanges({
    messages, getContentBlocks, findToolResult,
    startFromIndex: fileChangeMgmt.baseMessageIndex,
    // Sidechain Edit/Write from Agent/Task tools must appear in the Edits tab too
    subagentHistories,
  });

  const filteredFileChanges = useMemo(() => {
    const result = fileChangeMgmt.processedFiles.length === 0 ? fileChanges : fileChanges.filter((fc) => !fileChangeMgmt.processedFiles.includes(fc.filePath));
    cardDebugLog('[filteredFileChanges]', result.length, 'files:', result.map(f => f.filePath?.split('/').pop()));
    return result;
  }, [fileChanges, fileChangeMgmt.processedFiles]);

  const latestTurnMessages = useMemo(() => sliceLatestConversationTurn(messages), [messages]);

  // A run_in_background agent outlives the turn that launched it: the main turn
  // settles while the sidechain keeps running, and its terminal report arrives
  // as a later turn's task-notification user message. The turn-scoped narrowing
  // below exists to focus sync tool progress on the current turn; if the
  // session contains any async agent, narrowing would drop the agent's card
  // from StatusPanel while the user waits for it to return — the reported
  // "subagent list disappears after the session ends" symptom. Keep the full
  // conversation in scope in that case. The check reuses the same extraction
  // as the list itself (isAsyncAgentInput on the raw tool input) so the two
  // can never disagree.
  const asyncAgentPresence = useMemo(
    () => extractSubagentsFromMessages(messages, getContentBlocks, findToolResult, getToolResultRaw, {})
      .some((subagent) => subagent.isAsync === true),
    [messages, getContentBlocks, findToolResult, getToolResultRaw],
  );

  // While streaming, focus on the current turn's task progress; once settled
  // (history replay or idle), widen the scope to the whole conversation -
  // otherwise a multi-turn history session whose last turn has no task tool
  // would lose its task and subagent lists entirely.
  //
  // Exception: if the latest-turn slice carries no tool_use at all (e.g. a
  // same-session reload snapshot whose latest turn predates the active work, or
  // a text-only turn), widen to the full conversation. Without this, the
  // StatusPanel subagent/todo lists can briefly disappear when a deferred
  // reload's message refresh lands at the frontend a moment before the
  // stream-end signal flips streamingActive back to false. Widening only adds
  // content (earlier turns' settled items) - it never drops the current turn's.
  // A session with any async agent likewise never narrows (see asyncAgentPresence).
  const statusScopeMessages = useMemo(() => {
    const latestTurnHasToolUse = latestTurnMessages.length > 0 && sliceHasToolUse(latestTurnMessages, getContentBlocks);
    const result = computeStatusScopeMessages(streamingActive, asyncAgentPresence, latestTurnMessages, messages, latestTurnHasToolUse);
    cardDebugLog('[statusScope]', result.length, 'latestTurn:', latestTurnMessages.length, 'msgs:', messages.length, 'streaming:', streamingActive, 'toolUse:', latestTurnHasToolUse);
    return result;
  }, [streamingActive, asyncAgentPresence, latestTurnMessages, messages, getContentBlocks]);

  const latestTurnSubagents = useSubagents({
    messages: statusScopeMessages,
    getContentBlocks,
    findToolResult,
    getToolResultRaw,
    subagentHistories,
  });

  const subagents = useMemo(
    () => finalizeSubagentsForSettledTurn(latestTurnSubagents, streamingActive),
    [latestTurnSubagents, streamingActive],
  );

  const globalTodos = useMemo(() => {
    // Prefer authoritative todo list from opencode's `todo.updated` SSE event.
    if (sseTodos && sseTodos.length > 0) {
      const result = finalizeTodosForSettledTurn(sseTodos, streamingActive);
      cardDebugLog('[globalTodos] sseTodos:', result.length, 'todos:', result.map(t => t.content?.substring(0, 30)));
      return result;
    }
    // Fallback: derive from tool_use content blocks in messages.
    //
    // ⚠️  Use the FULL `messages` slice, not `statusScopeMessages`.
    //
    // `statusScopeMessages` narrows to the latest turn while a turn is
    // streaming (see computeStatusScopeMessages in turnScope.ts). But a
    // todoWrite call usually lands in the FIRST assistant message of the
    // turn — the "turn window" then scrolls past it before the next todo
    // update, so deriveTodosForTurn sees no tool_use / todo blocks and
    // returns []. As a result, the StatusPanel tasks tab shows nothing
    // during the turn and only populates after `streamingActive` flips to
    // false (which widens scope to the whole conversation).
    //
    // Todo lists are session-wide state, not per-turn. Deriving from the
    // full messages keeps the panel live throughout the turn.
    const result = deriveTodosForTurn(messages, getContentBlocks, streamingActive);
    cardDebugLog('[globalTodos] derived:', result.length, 'todos:', result.map(t => t.content?.substring(0, 30)));
    return result;
  }, [sseTodos, messages, getContentBlocks, streamingActive]);

  const sessionTitle = useMemo(() => {
    if (customSessionTitle) return customSessionTitle;
    if (messages.length === 0) return t('common.newSession');
    // Pick the first REAL prompt: skip meta/caveat messages and anything whose
    // text is raw internal XML (e.g. <local-command-caveat>) so the tag is
    // never leaked as the session title.
    let text = '';
    for (const message of messages) {
      if (message.type !== 'user') continue;
      const raw = message.raw;
      if (raw && typeof raw === 'object' && raw.isMeta === true) continue;
      const candidate = getMessageText(message).trim();
      if (!candidate) continue;
      if (candidate.startsWith('<')) continue;
      if (containsAnyTag(candidate, INTERNAL_METADATA_TAGS) || hasTaskNotificationTag(candidate)) continue;
      text = candidate;
      break;
    }
    if (!text) return t('common.newSession');
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [customSessionTitle, messages, t, getMessageText]);

  return {
    findToolResult,
    getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges,
    subagents,
    globalTodos,
    sessionTitle,
  };
}
