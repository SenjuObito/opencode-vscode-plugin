import { type RefObject, useCallback, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  SubagentHistoryResponse,
  TodoItem,
  ToolResultBlock,
} from '../types';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';
import { extractTodosFromToolUse, extractAccumulatedTasks } from '../utils/todoToolNormalization';
import {
  computeStatusScopeMessages,
  finalizeSubagentsForSettledTurn,
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

/**
 * Replay fallback for a session whose transcript is the only source of tasks
 * (no `todos.updated` state yet). The statuses come from the transcript as
 * written — a settled turn is never evidence that an unfinished task finished.
 */
export function deriveTodosForTurn(
  turnMessages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
): TodoItem[] {
  let latestTodos: ReturnType<typeof extractTodosFromToolUse> = null;
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const msg = turnMessages[i];
    if (msg.type !== 'assistant') continue;
    const blocks = getContentBlocks(msg);
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
    return latestTodos;
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
  getContentBlocks,
  sseTodos,
}: UseChatComputationsParams) {
  // Ref-backed index over the transcript: tool_use_id → result block + its raw
  // message.
  //
  // <p>Built once per transcript array identity (the store hands out a fresh
  // array on every change) so a render pass costs O(1) per tool card instead of
  // scanning the whole conversation for each one. The previous per-id cache
  // still scanned on every miss and grew without bound as the session went on —
  // together they made long conversations progressively slower.</p>
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolResultIndexRef = useRef<{
    source: ClaudeMessage[] | null;
    index: Map<string, { block: ToolResultBlock; raw: ClaudeRawMessage }>;
  }>({ source: null, index: new Map() });

  const toolResultIndex = useCallback((): Map<string, { block: ToolResultBlock; raw: ClaudeRawMessage }> => {
    const source = messagesRef.current;
    const cache = toolResultIndexRef.current;
    if (cache.source === source) {
      return cache.index;
    }
    const index = new Map<string, { block: ToolResultBlock; raw: ClaudeRawMessage }>();
    for (const candidate of source) {
      const raw = candidate.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = raw.content ?? raw.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== 'tool_result') continue;
        const id = (block as ToolResultBlock).tool_use_id;
        // The first occurrence wins, exactly like the linear scan did.
        if (typeof id === 'string' && !index.has(id)) {
          index.set(id, { block: block as ToolResultBlock, raw });
        }
      }
    }
    cache.source = source;
    cache.index = index;
    return index;
  }, []);

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') return null;
    return toolResultIndex().get(toolUseId)?.block ?? null;
  }, [toolResultIndex]);

  const getToolResultRaw = useCallback<GetToolResultRawFn>(
    (toolUseId: string) => toolResultIndex().get(toolUseId)?.raw ?? null,
    [toolResultIndex],
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
    return result;
  }, [streamingActive, asyncAgentPresence, latestTurnMessages, messages, getContentBlocks]);

  const latestTurnSubagents = useSubagents({
    messages: statusScopeMessages,
    getContentBlocks,
    findToolResult,
    getToolResultRaw,
  });

  const subagents = useMemo(
    () => finalizeSubagentsForSettledTurn(latestTurnSubagents, streamingActive),
    [latestTurnSubagents, streamingActive],
  );

  const globalTodos = useMemo(() => {
    // The engine's list is authoritative: `null` means "no canonical list yet"
    // and falls back to the transcript, while an empty array is a real state
    // (the engine cleared every task) and must clear the panel too. Statuses
    // are copied verbatim — a settled turn says nothing about `in_progress`.
    if (sseTodos !== null) {
      return sseTodos;
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
    const result = deriveTodosForTurn(messages, getContentBlocks);
    return result;
  }, [sseTodos, messages, getContentBlocks]);

  /**
   * The tab/header title is the engine's name for the session, never the text
   * of the first user message. The host applies `tab.title.changed` to its tab
   * record and the webview mirrors it into `customSessionTitle`; until then the
   * localized "new session" label is shown (same as idea's webview).
   */
  const sessionTitle = useMemo(
    () => customSessionTitle || t('common.newSession'),
    [customSessionTitle, t],
  );

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
