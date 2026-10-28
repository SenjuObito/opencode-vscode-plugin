import type { SubagentStatus, TaskEvent, ToolResultBlock } from '../types';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';

/**
 * Read the subagent/agent type from an Agent/Task tool input.
 *
 * v1 (opencode `task`, Claude Code `Agent`) uses `subagent_type` / `agent_type`
 * (snake_case and camelCase); opencode v2 renamed the tool to `subagent` and
 * the argument to `agent`. The v2 alias is read last so v1 inputs resolve
 * exactly as before — this is the single source of truth for the type label
 * shared by useSubagents, TaskExecutionBlock and AgentGroupBlock.
 */
export function readAgentType(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['subagent_type', 'subagentType', 'agent_type', 'agentType', 'agent']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Extract concatenated text content from a tool_result block.
 *
 * Shared by useSubagents, AgentGroupBlock, and TaskExecutionBlock so the
 * extraction logic (string vs array content, text-block filtering) stays in
 * one place. Returns undefined when there is no text to show.
 */
export function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

// Claude Code's async-launch ack is a fixed, hard-coded tool_result text. It is
// the only signal we can rely on across versions, because recent versions no longer
// guarantees a task_notification SDK event for background agents — the agent's
// terminal report is delivered solely as a main-session XML (see the ai-bridge
// interception in runtime-lifecycle.js). Matching this text is what keeps the
// card from flipping to "completed" the instant the ack lands.
//
// opencode v2 has no fixed wording: a background launch comes back either as the
// synthetic `<subagent sessionID="…" state="running">` notice or as the launch
// ack object `{ "sessionID": "…", "status": "running" }`. Both mean "the child
// started, not finished" and must be treated exactly like Claude's ack — keyed
// off the state, never off the `subagent` tag alone (a completed child also
// carries that tag).
const ASYNC_LAUNCH_TEXT = /Async agent launched|<subagent\b[^>]*\bstate\s*=\s*["']running["']|"status"\s*:\s*"running"/i;

/**
 * Whether an Agent/Task tool input launches a background (async) subagent.
 *
 * Claude Code triggers async via the `run_in_background: true` input parameter
 * (AgentTool schema), NOT via the tool name. normalizeToolInput preserves the
 * snake_case field via spread for the Agent/Task tools, so both the StatusPanel
 * list (useSubagents, normalized input) and the inline Agent cards
 * (AgentGroupBlock/TaskExecutionBlock, raw block.input) read the same field.
 *
 * Strict === true avoids truthy strings (e.g. "false") flipping the flag. The
 * camelCase `runInBackground` form is also checked as a guard against future
 * normalization changes. Shared by all three call sites so they cannot drift.
 *
 * Beyond the input flag, recent Claude Code also returns an `async_launched`
 * / `remote_launched` / `teammate_spawned` tool-use status and stamps the
 * launch ack with a fixed "Async agent launched" text. Both are accepted as
 * fallbacks so an agent whose input lacks `run_in_background` (e.g. spawned
 * via a different async path) is still recognized and does not get marked
 * completed on the launch ack alone.
 */
export function isAsyncAgentInput(
  input: unknown,
  normalizedToolName?: string,
  result?: ToolResultBlock | null,
  toolUseStatus?: unknown,
): boolean {
  if (normalizedToolName?.split('.').at(-1) === 'spawn_agent') return true;
  if (!input || typeof input !== 'object') {
    // Even a stripped input still betrays an async launch via its ack text or
    // tool-use status, so do not fall through to "sync" just because input is
    // missing.
    return isAsyncLaunchStatus(toolUseStatus) || isAsyncLaunchText(result);
  }
  const record = input as Record<string, unknown>;
  if (record.run_in_background === true || record.runInBackground === true) return true;
  // opencode v2 renamed the `task` tool to `subagent` and its async switch to
  // `background: true` (same semantics: return immediately, notify the parent
  // when the child session finishes).
  if (record.background === true) return true;
  return isAsyncLaunchStatus(toolUseStatus) || isAsyncLaunchText(result);
}

function isAsyncLaunchText(result?: ToolResultBlock | null): boolean {
  const text = extractResultText(result);
  return !!text && ASYNC_LAUNCH_TEXT.test(text);
}

const ASYNC_LAUNCH_STATUSES = new Set(['async_launched', 'remote_launched', 'teammate_spawned']);

function isAsyncLaunchStatus(status: unknown): boolean {
  return typeof status === 'string' && ASYNC_LAUNCH_STATUSES.has(status);
}

/**
 * Read the `status` field of a tool_result's toolUseResult metadata, returning
 * undefined for any shape that does not carry one. Centralized so the three
 * isAsyncAgentInput call sites extract the same field without drifting.
 */
export function readToolUseStatus(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const toolUseResult = record.toolUseResult;
  if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) {
    return undefined;
  }
  return (toolUseResult as Record<string, unknown>).status;
}

export interface SubagentRunStateInput {
  /** True when the parent result is only a launch acknowledgement (async agent). */
  isAsync: boolean;
  /** True when a tool_result block exists for this call. */
  hasTerminalResult: boolean;
  resultIsError?: boolean;
  /**
   * Canonical terminal event pushed by core (`subagent.status`), for inline and
   * background calls alike. Absent while the run is still going, and on history
   * replay (no events are replayed).
   */
  terminalEvent?: Pick<TaskEvent, 'status'> | null;
}

/**
 * The single status derivation for a subagent run.
 *
 * <p>Core publishes `subagent.status` for both launch modes, so a terminal event
 * is always the first source. The parent tool result is the replay/bootstrap
 * source: a reloaded session has no events, and an inline call's result is its
 * child's final report. A launch acknowledgement is never terminal, which is
 * why an async run stays `running` until its event arrives.</p>
 *
 * <p>Child transcripts (`subagent.history`) are deliberately NOT an input. A
 * transcript snapshot is a point-in-time read that can be older than the run's
 * terminal state; treating it as status is what pinned the card spinner. The
 * transcript remains the detail view's data source only.</p>
 */
export function resolveSubagentRunState({
  isAsync,
  hasTerminalResult,
  resultIsError,
  terminalEvent,
}: SubagentRunStateInput): SubagentStatus {
  if (terminalEvent) {
    return terminalEvent.status === 'failed' || terminalEvent.status === 'stopped'
      ? 'error'
      : 'completed';
  }
  if (isAsync) {
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits an event.
    return resultIsError ? 'error' : 'running';
  }
  if (!hasTerminalResult) return 'running';
  return resultIsError ? 'error' : 'completed';
}

export interface SpawnAgentMeta {
  agentId?: string;
  agentPath?: string;
  description?: string;
  nickname?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Parse Codex spawn_agent launch metadata without conflating task_name with an agent UUID. */
export function parseSpawnAgentMeta(
  input: Record<string, unknown>,
  result?: ToolResultBlock | null,
): SpawnAgentMeta {
  const text = extractResultText(result)?.trim();
  let parsed: Record<string, unknown> | null = null;

  if (text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      const candidate = JSON.parse(text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  const getString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const modelMatch = text?.match(/\(([A-Za-z0-9._:-]+)(?:\s+(low|medium|high|xhigh))?\)/i);
  const agentId = getString(parsed?.agent_id, parsed?.agentId, input.agent_id, input.agentId)
    ?? text?.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1];
  const agentPath = getString(
      parsed?.agent_path,
      parsed?.agentPath,
      parsed?.task_name,
      parsed?.taskName,
      input.agent_path,
      input.agentPath,
      input.task_name,
      input.taskName,
    );
  const description = getString(parsed?.description, input.description);
  const nickname = getString(parsed?.nickname, parsed?.name, input.nickname);
  const model = getString(parsed?.model, input.model) ?? modelMatch?.[1];
  const reasoningEffort = getString(
      parsed?.reasoning_effort,
      parsed?.reasoningEffort,
      input.reasoning_effort,
      input.reasoningEffort,
    ) ?? modelMatch?.[2];
  return {
    ...(agentId && { agentId }),
    ...(agentPath && { agentPath }),
    ...(description && { description }),
    ...(nickname && { nickname }),
    ...(model && { model }),
    ...(reasoningEffort && { reasoningEffort }),
  };
}

/**
 * Per-agent usage metadata the SDK stamps on the tool_result's toolUseResult
 * field (agentId, totalDurationMs, totalTokens, totalToolUseCount). Shared by
 * AgentGroupBlock and TaskExecutionBlock so the field extraction stays single-
 * sourced. Returns an empty object when there is no usable metadata.
 */
export function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): { agentId?: string; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number } {
  if (!toolUseId) return {};
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
  };
}
