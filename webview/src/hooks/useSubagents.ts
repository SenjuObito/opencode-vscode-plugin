import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentInfo, SubagentStatus, TaskEvent, TaskEventMap } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { AGENT_TOOL_NAMES, isToolName, normalizeToolName } from '../utils/toolConstants';
import { extractResultText, isAsyncAgentInput, parseSpawnAgentMeta, readAgentType, readToolUseStatus, resolveSubagentRunState } from '../utils/subagentResult';
import { useTaskEvents } from '../contexts/SubagentContext';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
}

/**
 * Determine subagent status.
 *
 * Async agents (Agent/Task tool invoked with run_in_background:true) only
 * receive a launch acknowledgment tool_result, not a completion signal. The
 * terminal status arrives later via a task_notification event, so while no
 * event has landed the agent is still running.
 *
 * Sync agents (task/agent without run_in_background) run inline: a tool_result
 * means the agent is done.
 */
// 运行态推导只有一个实现（utils/subagentResult.resolveSubagentRunState）。
// 这里只是把 hook 的入参适配成它的归一化形状。
function determineStatus(
  result: ToolResultBlock | null,
  isAsync: boolean,
  taskEvent: TaskEvent | undefined,
): SubagentStatus {
  return resolveSubagentRunState({
    isAsync,
    hasTerminalResult: result != null,
    resultIsError: result?.is_error === true,
    terminalEvent: taskEvent ?? null,
  });
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
  taskEvent: TaskEvent | undefined,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record?.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  // task_notification wins over toolUseResult: for async agents the launch
  // tool_result carries no usage, so the event is the only source of truth.
  return {
    agentId: taskEvent?.agentId ?? getString(record?.agentId),
    totalDurationMs: taskEvent?.totalDurationMs ?? getNumber(record?.totalDurationMs),
    totalTokens: taskEvent?.totalTokens ?? getNumber(record?.totalTokens),
    totalToolUseCount: taskEvent?.totalToolUseCount ?? getNumber(record?.totalToolUseCount),
    toolStats,
    resultText: taskEvent?.summary ?? extractResultText(result),
  };
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  taskEvents: TaskEventMap = {},
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');

      // Only process task/agent-style subagent tool calls. `subagent` is the
      // opencode v2 name for the v1 `task` tool; accepting both keeps the list
      // working on v1 and v2 without an engine branch at this layer.
      if (!isToolName(block.name, AGENT_TOOL_NAMES)) return;

      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
      if (!input) return;

      // Defensive: ensure all string values are actually strings
      const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
      // Shared with TaskExecutionBlock / AgentGroupBlock: v1 reads
      // subagent_type / agent_type, opencode v2 renamed the argument to `agent`.
      const subagentType = readAgentType(input);
      const description = String((input.description as string) ?? '');
      const prompt = String((input.prompt as string) ?? '');

      // Check tool result to determine status
      const toolUseId = block.id ?? '';
      const result = findToolResult(toolUseId, messageIndex);
      const taskEvent = taskEvents[toolUseId];
      // isAsync is read via the shared isAsyncAgentInput helper so the
      // StatusPanel list and the inline Agent cards stay in lockstep. The
      // launch ack text and tool-use status are passed as fallbacks so a
      // background agent whose input lacks run_in_background is still kept
      // "running" until its terminal event lands, instead of being marked
      // completed the instant the ack arrives.
      const toolUseStatus = readToolUseStatus(getToolResultRaw(toolUseId));
      const isAsync = isAsyncAgentInput(input, toolName, result, toolUseStatus);
      const status = determineStatus(result, isAsync, taskEvent);
      const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId, taskEvent);
      const spawnMeta = toolName === 'spawn_agent' ? parseSpawnAgentMeta(input, result) : {};

      subagents.push({
        id,
        type: subagentType,
        description,
        prompt,
        status,
        isAsync,
        messageIndex,
        ...resultMetadata,
        ...(spawnMeta.agentId && { agentId: spawnMeta.agentId }),
        ...(spawnMeta.agentPath && { agentPath: spawnMeta.agentPath }),
      });
    });
  });

  return subagents;
}

/**
 * Hook to extract subagent information from Task tool calls.
 *
 * <p>Status comes only from the canonical `subagent.status` event (stored in
 * TaskEventMap) and the parent tool result. Child transcripts are detail data
 * and deliberately do not participate in status derivation: a transcript
 * snapshot can be older than the run and must not pin or prematurely complete
 * the spinner.</p>
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
}: UseSubagentsParams): SubagentInfo[] {
  const taskEvents = useTaskEvents();
  return useMemo(
    () => extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult,
      getToolResultRaw,
      taskEvents,
    ),
    [messages, getContentBlocks, findToolResult, getToolResultRaw, taskEvents],
  );
}
