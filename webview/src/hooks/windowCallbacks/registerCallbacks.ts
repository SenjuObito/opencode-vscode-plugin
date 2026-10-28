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
import { isTaskEventForSession, parseTaskNotification } from '../../utils/taskEventParser';
import { deepEqual } from '../../utils/deepEqual';
import { normalizeTodoStatus } from '../../utils/todoShared';
import { getTabStore } from '../../store/tabStore';
import type { SubagentHistoryResponse } from '../../types/subagent';
import type { TodoItem } from '../../types';
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

/**
 * 把 opencode 的 todo 条目归一化成前端的 TodoItem（与 idea 同形）。
 *
 * 服务端的字段名不统一（content / step / title / text / subject / description），
 * 状态也要归一（done → completed、running → in_progress、cancelled → completed）。
 */
function normalizeTodoItems(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
    .map((item, index) => {
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
      } as TodoItem;
    });
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
  // 跨会话安全：
  //   1. 宿主（SessionCallbackAdapter.onTaskEvent）会把会话 id 写进载荷；
  //      这里按它丢弃别的 tab 的事件 —— 多 tab 后一个 webview 只有一份面板状态，
  //      不筛就会把后台 tab 的子代理完成通知写进当前 tab 的列表。
  //   2. beginSessionTransition（useSessionManagement）切会话时清空 taskEvents。
  //   3. tool_use_id 全局唯一，迟到的同会话事件只会更新它自己的条目。
  window.onTaskEvent = (eventJson: string) => {
    try {
      if (!options.setTaskEvents) return;
      const parsed = JSON.parse(eventJson) as unknown;
      if (!isTaskEventForSession(parsed, options.currentSessionIdRef.current)) {
        return;
      }
      const taskEvent = parseTaskNotification(parsed);
      if (!taskEvent) return;
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
  window.onTodoUpdated = (payload: string) => {
    try {
      cardDebugLog('[onTodoUpdated] received payload length:', payload?.length);
      const { sessionID, todos } = JSON.parse(payload);
      cardDebugLog('[onTodoUpdated] parsed sessionID:', sessionID, 'currentSessionId:', options.currentSessionIdRef.current, 'todos count:', todos?.length);

      const normalizedTodos = normalizeTodoItems(todos);
      if (!normalizedTodos) {
        cardDebugLog('[onTodoUpdated] SKIPPED: todos is not an array');
        return;
      }

      // 归属：宿主给的 sessionID 反查 tab。查得到就写进**那个 tab**（后台 tab 的
      // 待办不该被丢弃，否则切回去时列表是空的）；查不到才按旧规则丢弃。
      const tabStore = getTabStore();
      const ownerTabId = sessionID ? tabStore.findIdBySession(sessionID) : null;
      const activeTabId = tabStore.getActiveTabId();

      if (ownerTabId && ownerTabId !== activeTabId) {
        cardDebugLog('[onTodoUpdated] writing to background tab', ownerTabId, normalizedTodos.length, 'todos');
        tabStore.updateTab(ownerTabId, (tab) => ({ ...tab, sseTodos: normalizedTodos }));
        return;
      }

      if (sessionID && sessionID !== options.currentSessionIdRef.current) {
        cardDebugLog('[onTodoUpdated] SKIPPED: sessionID mismatch');
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
      // Ignore malformed todo event payloads.
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
