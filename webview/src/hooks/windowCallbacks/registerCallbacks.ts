/**
 * registerCallbacks.ts
 *
 * Single entry point that mounts all window bridge callbacks.  Called once
 * inside useWindowCallbacks' useEffect.  Receives the full options bag from
 * the hook rather than individual parameters to keep the call-site tidy.
 *
 * Pure functions have been extracted to messageSync.ts / sessionTransition.ts /
 * settingsBootstrap.ts; callback groups are further split into dedicated
 * sub-modules under registerCallbacks/ for easier navigation and maintenance.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../useWindowCallbacks';
import { cardDebugLog } from '../../utils/bridge';
import { parseTaskNotification } from '../../utils/taskEventParser';
import { deepEqual } from '../../utils/deepEqual';
import type { SubagentHistoryResponse } from '../../types/subagent';
import type { TodoItem } from '../../types';
import { normalizeTodoStatus } from '../../utils/todoShared';
import {
  setupSlashCommandsCallback,
  resetSlashCommandsState,
  resetFileReferenceState,
  setupDollarCommandsCallback,
  resetDollarCommandsState,
} from '../../components/ChatInputBox/providers';
import { buildResetTransientUiState } from './sessionTransition';
import { startModeRequest } from './settingsBootstrap';
import { registerMessageCallbacks } from './registerCallbacks/messageCallbacks';
import { registerStreamingCallbacks } from './registerCallbacks/streamingCallbacks';
import { registerSessionCallbacks } from './registerCallbacks/sessionCallbacks';
import { registerUsageModeCallbacks } from './registerCallbacks/usageModeCallbacks';
import { registerPermissionCallbacks } from './registerCallbacks/permissionCallbacks';
import { registerAgentAndSelectionCallbacks } from './registerCallbacks/agentCallbacks';

function areSubagentMessagesEquivalent(previousMessages: unknown[] | undefined, nextMessages: unknown[] | undefined): boolean {
  if (previousMessages === nextMessages) return true;
  return deepEqual(previousMessages, nextMessages);
}

const pendingSubagentHistoryChunks = new Map<string, string[]>();
const MAX_PENDING_SUBAGENT_HISTORY_TRANSFERS = 16;

function appendSubagentHistoryChunk(transferId: string, chunk: string, isFinal: string | boolean): void {
  if (!transferId) return;
  const chunks = pendingSubagentHistoryChunks.get(transferId) ?? [];
  chunks.push(chunk);
  if (isFinal === true || isFinal === 'true') {
    pendingSubagentHistoryChunks.delete(transferId);
    window.onSubagentHistoryLoaded?.(chunks.join(''));
    return;
  }
  if (pendingSubagentHistoryChunks.size >= MAX_PENDING_SUBAGENT_HISTORY_TRANSFERS) {
    const oldestTransferId = pendingSubagentHistoryChunks.keys().next().value;
    if (oldestTransferId) pendingSubagentHistoryChunks.delete(oldestTransferId);
  }
  pendingSubagentHistoryChunks.set(transferId, chunks);
}

export function registerWindowCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<UseWindowCallbacksOptions['t']>,
  requestHistoryRenderCommit: (refreshEpoch: number) => void,
): void {
  // -------------------------------------------------------------------------
  // Session transition helpers
  // -------------------------------------------------------------------------

  const resetTransientUiState = buildResetTransientUiState({
    clearToasts: options.clearToasts,
    setStatus: options.setStatus,
    setLoading: options.setLoading,
    setLoadingStartTime: options.setLoadingStartTime,
    setIsThinking: options.setIsThinking,
    setStreamingActive: options.setStreamingActive,
    setSessionLoading: options.setSessionLoading,
    setIsCompacting: options.setIsCompacting,
    setCompactingStartTime: options.setCompactingStartTime,
    isStreamingRef: options.isStreamingRef,
    useBackendStreamingRenderRef: options.useBackendStreamingRenderRef,
    streamingMessageIndexRef: options.streamingMessageIndexRef,
    streamingContentRef: options.streamingContentRef,
    streamingThinkingRef: options.streamingThinkingRef,
    autoExpandedThinkingKeysRef: options.autoExpandedThinkingKeysRef,
    contentUpdateTimeoutRef: options.contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef: options.thinkingUpdateTimeoutRef,
    streamingTurnIdRef: options.streamingTurnIdRef,
    // Leaving a session does not stop its turn. Archive the live streaming
    // runtime before the refs below are wiped, otherwise a session that keeps
    // running in the background loses its accumulator / turnId and the next
    // activation renders the previous session's text into the new one.
    onBeforeResetTransientState: () => {
      window.__sessionTabsStore?.archiveActiveStreamingRuntime?.();
    },
  });

  // Expose as single entry point for session transition cleanup.
  // beginSessionTransition (useSessionManagement) calls this to synchronously
  // clear both React state AND internal refs in one shot.
  window.__resetTransientUiState = resetTransientUiState;

  // =========================================================================
  // Register callback groups
  // =========================================================================

  registerMessageCallbacks(options, resetTransientUiState, requestHistoryRenderCommit);
  registerStreamingCallbacks(options);
  registerSessionCallbacks(options, tRef);
  registerUsageModeCallbacks(options);
  registerPermissionCallbacks(options);
  registerAgentAndSelectionCallbacks(options);

  window.onSubagentHistoryChunk = appendSubagentHistoryChunk;

  // 通知「查看」动作：宿主已 reveal 对应原生 panel，这里把视图内标签也切过去。
  // 找不到绑定的 tab 就忽略——会话可能已被用户关闭，但不该因此报错。
  window.focus_session = (sessionId: string) => {
    if (!sessionId) return;
    cardDebugLog('[focus_session] switching to session:', sessionId);
    window.__sessionTabsStore?.focusSession?.(sessionId);
  };

  window.onSubagentHistoryLoaded = (json: string) => {
    // 子代理 transcript 上限：Record 按插入序保留最近 MAX_SUBAGENT_HISTORIES
    // 条。每条持有完整子代理消息数组，agent 重度会话里无界累积会把渲染进程
    // 内存拖高；被裁掉的条目可由用户重新展开该 Agent 行（触发重新拉取）。
    const MAX_SUBAGENT_HISTORIES = 50;
    try {
      if (!options.setSubagentHistories) return;
      const result = JSON.parse(json);
      const key = result.toolUseId || result.agentId;
      if (!key) return;
      options.setSubagentHistories((prev) => {
        const existing = prev[key];
        // Skip state update when the payload is structurally identical.
        // This prevents cascading re-renders and scroll jumps caused by
        // periodic subagent polling (every 2 s) returning unchanged data.
        if (existing && existing.success === result.success
          && existing.completed === result.completed
          && existing.status === result.status
          && existing.error === result.error
          && existing.sessionId === result.sessionId
          && existing.provider === result.provider
          && existing.toolUseId === result.toolUseId
          && existing.agentId === result.agentId
          && existing.agentPath === result.agentPath
          && areSubagentMessagesEquivalent(existing.messages, result.messages)) {
          return prev;
        }
        const next: Record<string, SubagentHistoryResponse> = { ...prev, [key]: result as SubagentHistoryResponse };
        if (Object.keys(next).length <= MAX_SUBAGENT_HISTORIES) {
          return next;
        }
        // 超限：丢掉最旧的条目（先重建为删除序，再保留最近 N 条）。
        const oldestFirst = Object.keys(next).filter((k) => k !== key);
        const keep = new Set([...oldestFirst.slice(oldestFirst.length - (MAX_SUBAGENT_HISTORIES - 1)), key]);
        for (const k of Object.keys(next)) {
          if (!keep.has(k)) delete next[k];
        }
        return next;
      });
    } catch {
      // Ignore malformed callback payloads; the request can be retried by reopening the Agent row.
    }
  };

  // task_* SDK system events signal the lifecycle of a background Agent
  // (Agent/Task tool invoked with run_in_background:true). Only
  // task_notification carries a terminal status; task_started / task_progress
  // merely announce progress and must not flip the running state. Without
  // this, the StatusPanel cannot tell a launched async agent from a finished
  // one, and the completion summary never surfaces.
  //
  // The host sends `(sessionId, eventJson)` since multi-session routing landed.
  // Accepting a single argument as well keeps old payload shapes working while
  // the arity contract test guards against future drift.
  window.onTaskEvent = (arg0: string, arg1?: string) => {
    const [targetSessionId, eventJson] = typeof arg1 !== 'undefined' ? [arg0, arg1] : [null, arg0];
    try {
      const taskEvent = parseTaskNotification(JSON.parse(eventJson));
      if (!taskEvent) return;

      // Background sessions must accumulate their own agent state; writing it
      // into the active tab would leak one conversation's subagents into another.
      if (targetSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(targetSessionId)) {
        window.__sessionTabsStore.updateBackgroundTab(
          (t) => t.sessionId === targetSessionId,
          (t) => {
            t.taskEvents = { ...(t.taskEvents || {}), [taskEvent.toolUseId]: taskEvent };
          }
        );
        return;
      }

      if (!options.setTaskEvents) return;
      const { toolUseId } = taskEvent;
      options.setTaskEvents((prev) => {
        const existing = prev[toolUseId];
        // Dedup: skip the state update when no observable field changed. Include
        // agentId/outputFilePath so a follow-up event that adds the sidechain
        // transcript path still lands (task_notification is terminal, but a
        // late output_file attachment would otherwise be swallowed).
        if (existing
          && existing.status === taskEvent.status
          && existing.summary === taskEvent.summary
          && existing.totalTokens === taskEvent.totalTokens
          && existing.totalToolUseCount === taskEvent.totalToolUseCount
          && existing.totalDurationMs === taskEvent.totalDurationMs
          && existing.agentId === taskEvent.agentId
          && existing.outputFilePath === taskEvent.outputFilePath) {
          return prev;
        }
        return { ...prev, [toolUseId]: taskEvent };
      });
    } catch {
      // Ignore malformed task event payloads. A task_notification is terminal,
      // so a dropped event is not retried - but a later task_progress /
      // task_notification for the same tool_use_id will still land and update
      // the entry, so the subagent list is not permanently stuck.
    }
  };

  // opencode todo.updated SSE event — stores authoritative todo list
  window.onTodoUpdated = (arg0: string, arg1?: string) => {
    const [targetSessionId, payload] = typeof arg1 !== 'undefined' ? [arg0, arg1] : [null, arg0];
    if (!payload) return;
    try {
      cardDebugLog('[onTodoUpdated] received payload length:', payload.length);
      let parsed = JSON.parse(payload);
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      const sessionID = parsed?.sessionID ?? parsed?.sessionId;
      const rawTodos = parsed?.todos;
      const effectiveSessionId = targetSessionId || sessionID;

      if (!Array.isArray(rawTodos)) {
        cardDebugLog('[onTodoUpdated] SKIPPED: todos is not an array', rawTodos);
        return;
      }

      const normalizedTodos: TodoItem[] = rawTodos
        .filter((item): item is NonNullable<typeof item> => item != null && typeof item === 'object')
        .map((item: any, index: number) => {
          const content = item.content || item.step || item.title || item.text || item.subject || item.description || '';
          return {
            id: item.id != null ? String(item.id) : String(index),
            content: typeof content === 'string' ? content.trim() : String(content),
            status: normalizeTodoStatus(item.status),
            ...(Array.isArray(item.blockedBy)
              ? {
                  blockedBy: item.blockedBy
                    .map((id: unknown) => (id != null ? String(id) : null))
                    .filter((id: unknown): id is string => id !== null),
                }
              : {}),
          };
        });

      if (effectiveSessionId && window.__sessionTabsStore && !window.__sessionTabsStore.isActiveSession(effectiveSessionId)) {
        cardDebugLog('[onTodoUpdated] updating background tab:', effectiveSessionId, 'with', normalizedTodos.length, 'todos');
        window.__sessionTabsStore.updateBackgroundTab(
          (t) => t.sessionId === effectiveSessionId,
          (t) => {
            t.sseTodos = normalizedTodos;
          }
        );
        return;
      }

      if (effectiveSessionId && options.currentSessionIdRef.current && effectiveSessionId !== options.currentSessionIdRef.current) {
        cardDebugLog('[onTodoUpdated] SKIPPED: sessionID mismatch, effective:', effectiveSessionId, 'current:', options.currentSessionIdRef.current);
        return;
      }
      if (options.setSseTodos) {
        cardDebugLog('[onTodoUpdated] calling setSseTodos with', normalizedTodos.length, 'todos');
        options.setSseTodos(normalizedTodos);
      } else {
        cardDebugLog('[onTodoUpdated] SKIPPED: setSseTodos is undefined');
      }
    } catch (e) {
      console.error('[onTodoUpdated] parse error:', e);
    }
  };

  // =========================================================================
  // Slash Commands Setup
  // =========================================================================

  resetSlashCommandsState();
  resetDollarCommandsState();
  resetFileReferenceState();
  setupSlashCommandsCallback();
  setupDollarCommandsCallback();

  // =========================================================================
  // Request Initial States
  // =========================================================================

  startModeRequest();
}
