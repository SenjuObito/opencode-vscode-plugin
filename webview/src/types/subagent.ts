/**
 * Subagent status
 */
export type SubagentStatus = 'running' | 'completed' | 'error';

/**
 * Terminal status carried by a subagent run event.
 *
 * <p>Two producers feed it: a Claude Code task_notification SDK event (legacy
 * async Agent) and core's engine-neutral `subagent.status` (opencode v1 `task`
 * and v2 `subagent`, inline and background alike). Maps onto SubagentStatus:
 * failed/stopped -> error, completed -> completed.</p>
 */
export type TaskEventStatus = 'completed' | 'failed' | 'stopped';

/**
 * The canonical terminal event for a subagent run.
 *
 * <p>Historically shaped like Claude Code's task_notification (hence the name),
 * but it is now the single live status source for every subagent call: core
 * publishes `subagent.status` for inline calls too. `summary`/usage fields are
 * filled when the producer knows them; consumers must not infer completion from
 * a launch acknowledgement or a child transcript snapshot.</p>
 */
export interface TaskEvent {
  /** tool_use_id of the subagent call; matches SubagentInfo.id */
  toolUseId: string;
  /** Runtime agent/child session id; locates the sidechain transcript */
  agentId?: string;
  /** Terminal status of the run */
  status: TaskEventStatus;
  /** Human-readable result summary */
  summary?: string;
  /** Token usage reported at completion */
  totalTokens?: number;
  /** Tool invocation count reported at completion */
  totalToolUseCount?: number;
  /** Total runtime in milliseconds, when reported */
  totalDurationMs?: number;
  /** Path to the sidechain JSONL transcript */
  outputFilePath?: string;
}

/** Map of tool_use_id -> latest task_* event for async subagents. */
export type TaskEventMap = Record<string, TaskEvent>;

export interface SubagentHistoryResponse {
  success: boolean;
  /** True only when the sidechain transcript ends with an assistant end_turn. */
  completed?: boolean;
  toolUseId?: string;
  agentId?: string;
  agentPath?: string;
  sessionId?: string;
  provider?: string;
  status?: SubagentStatus;
  error?: string;
  messages?: unknown[];
}

/**
 * Subagent information extracted from Task tool calls
 */
export interface SubagentInfo {
  /** Unique identifier (tool_use block id) */
  id: string;
  /** Subagent type (e.g., 'Explore', 'Plan', 'Bash') */
  type: string;
  /** Short description of the task */
  description: string;
  /** Full prompt content */
  prompt?: string;
  /** Execution status */
  status: SubagentStatus;
  /**
   * True for async agents (Agent/Task tool with run_in_background:true).
   * Their terminal status arrives live via task_notification; after history
   * reload it is recovered from the sidechain transcript's terminal end_turn.
   */
  isAsync?: boolean;
  /** Message index where this subagent was invoked */
  messageIndex: number;
  /** Stable runtime agent id returned by Claude Code, used to locate sidechain logs */
  agentId?: string;
  /** Codex agent path derived from spawn_agent task_name. */
  agentPath?: string;
  /** Total runtime in milliseconds */
  totalDurationMs?: number;
  /** Total tokens reported by the Agent tool */
  totalTokens?: number;
  /** Total tool calls reported by the Agent tool */
  totalToolUseCount?: number;
  /** Per-tool usage counters reported by the Agent tool */
  toolStats?: Record<string, number>;
  /** Final Agent output, when available from the tool result */
  resultText?: string;
}
