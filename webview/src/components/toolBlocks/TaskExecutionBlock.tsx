import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { AGENT_TOOL_NAMES, isToolName, normalizeToolName } from '../../utils/toolConstants';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  extractResultText,
  isAsyncAgentInput,
  parseAgentToolMeta,
  parseSpawnAgentMeta,
  readAgentType,
  readToolUseStatus,
  resolveSubagentRunState,
} from '../../utils/subagentResult';
import {
  useSubagentHistories,
  useSessionId,
  useSessionProvider,
  useGetToolResultRaw,
  useTaskEvent,
} from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--cc-gui-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface TaskExecutionBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  isStreaming?: boolean;
}

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

const TaskExecutionBlock = memo(function TaskExecutionBlock({ name, input, result, toolId }: TaskExecutionBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const histories = useSubagentHistories();
  const currentSessionId = useSessionId();
  const currentProvider = useSessionProvider();
  const getToolResultRaw = useGetToolResultRaw();
  const taskEvent = useTaskEvent(toolId);

  // Compute derived values up front, guarding input, so both useEffects below
  // run before the !input early return (React rules-of-hooks). input is always
  // defined for tool_use blocks in practice; the guard keeps hook order stable.
  const normalizedName = input ? normalizeToolName(name ?? '') : '';
  const isSpawnAgent = normalizedName === 'spawn_agent';
  const isAgentTool = isToolName(name, AGENT_TOOL_NAMES);
  const {
    description,
    prompt,
    model: _model,
    reasoning_effort: _reasoningEffort,
    reasoningEffort: _reasoningEffortCamel,
    nickname: _nickname,
    name: _inputName,
    agent_id: _agentId,
    agentId: _agentIdCamel,
    agent_path: _agentPath,
    agentPath: _agentPathCamel,
    ...rest
  } = input ?? ({} as ToolInput);
  const spawnMeta = isSpawnAgent && input
    ? parseSpawnAgentMeta(input as Record<string, unknown>, result)
    : {};
  const agentToolMeta = !isSpawnAgent && input ? parseAgentToolMeta(getToolResultRaw, toolId) : {};
  const agentId = spawnMeta.agentId ?? agentToolMeta.agentId;
  const agentPath = spawnMeta.agentPath;
  // Shared with useSubagents / AgentGroupBlock: v1 reads subagent_type /
  // agent_type, opencode v2 renamed the argument to `agent`.
  const identityLabel = spawnMeta.nickname || readAgentType(input) || undefined;
  const modelSummary = [spawnMeta.model, spawnMeta.reasoningEffort].filter(Boolean).join(' ');
  const shortAgentId = shortenAgentId(agentId);

  // A background (run_in_background) Agent only gets a launch acknowledgment
  // tool_result; its real terminal status arrives later via core's
  // `subagent.status` event, so the card must stay "running" until that event
  // lands and must not flip to completed on the launch ack alone. Sync agents
  // run inline, so a tool_result means done. A failed launch (validation error
  // before the task was registered) returns an is_error tool_result and never
  // emits an event, so treat that as an error instead of staying stuck.
  //
  // One status rule for the whole UI (shared with the StatusPanel and
  // AgentGroupBlock): core's `subagent.status` event is the live authority for
  // inline and background runs alike; the parent tool result is the
  // replay/bootstrap source. The child transcript is detail data only — a
  // `running` snapshot can be older than the run and must not pin the spinner.
  const isAsync = input
    ? isAsyncAgentInput(input, normalizedName, result, readToolUseStatus(toolId ? getToolResultRaw(toolId) : null))
    : false;
  const hasTerminalResult = result !== undefined && result !== null;
  const history = (toolId ? histories[toolId] : undefined) ?? (agentId ? histories[agentId] : undefined);
  const status = resolveSubagentRunState({
    isAsync,
    hasTerminalResult,
    resultIsError: result?.is_error === true,
    terminalEvent: taskEvent,
  });
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  // For background agents the task_notification carries the authoritative usage
  // and summary (the launch ack has none); prefer it over toolUseResult. Sync
  // agents keep reading toolUseResult as before.
  const detailAgentId = (isAsync ? taskEvent?.agentId : undefined) ?? agentId;
  const detailDurationMs = (isAsync ? taskEvent?.totalDurationMs : undefined) ?? agentToolMeta.totalDurationMs;
  const detailTokens = (isAsync ? taskEvent?.totalTokens : undefined) ?? agentToolMeta.totalTokens;
  const detailToolUseCount = (isAsync ? taskEvent?.totalToolUseCount : undefined) ?? agentToolMeta.totalToolUseCount;
  const detailResultText = (isAsync ? taskEvent?.summary : undefined) ?? extractResultText(result);

  useEffect(() => {
    if (!input || !expanded || !isAgentTool || !currentSessionId || !toolId || history) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      provider: currentProvider,
      agentId,
      agentPath,
      description: typeof description === 'string' ? description : undefined,
      toolUseId: toolId,
    }));
  }, [input, agentId, agentPath, currentProvider, currentSessionId, description, expanded, history, isAgentTool, toolId]);

  // No status polling here: core pushes `subagent.status` for both launch
  // modes, and the request above only fills the expanded detail view.

  if (!input) {
    return null;
  }

  return (
    <div className="task-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-tools tool-title-icon" />

          <span className="tool-title-text">
            {name ?? t('tools.task')}
          </span>
          {identityLabel && (
            <span className="tool-title-summary">{identityLabel}</span>
          )}
          {modelSummary && (
            <span className="tool-title-summary">· {modelSummary}</span>
          )}
          {shortAgentId && (
            <span className="tool-title-summary" style={MONO_FONT_STYLE}>
              · {shortAgentId}
            </span>
          )}

          {!isSpawnAgent && typeof description === 'string' && (
            <span className="task-summary-text tool-title-summary" title={description} style={NORMAL_WEIGHT_STYLE}>
              {description}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>
      </div>

      {expanded && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {spawnMeta.nickname && (
              <div className="task-field">
                <div className="task-field-label">nickname</div>
                <div className="task-field-content">{spawnMeta.nickname}</div>
              </div>
            )}

            {spawnMeta.model && (
              <div className="task-field">
                <div className="task-field-label">model</div>
                <div className="task-field-content">{spawnMeta.model}</div>
              </div>
            )}

            {spawnMeta.reasoningEffort && (
              <div className="task-field">
                <div className="task-field-label">reasoning_effort</div>
                <div className="task-field-content">{spawnMeta.reasoningEffort}</div>
              </div>
            )}

            {spawnMeta.agentId && (
              <div className="task-field">
                <div className="task-field-label">agent_id</div>
                <div className="task-field-content">{spawnMeta.agentId}</div>
              </div>
            )}

            {isAgentTool && (
              <SubagentProcessDetails
                agentId={detailAgentId}
                totalDurationMs={detailDurationMs}
                totalTokens={detailTokens}
                totalToolUseCount={detailToolUseCount}
                resultText={detailResultText}
                prompt={typeof prompt === 'string' ? prompt : undefined}
                history={history}
                canLoad={Boolean(currentSessionId)}
              />
            )}

            {typeof prompt === 'string' && (
              <div className="task-field">
                <div className="task-field-label">
                  <span className="codicon codicon-comment" />
                  {t('tools.promptLabel')}
                </div>
                <div className="task-field-content">{prompt}</div>
              </div>
            )}

            {Object.entries(rest).map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">
                  {typeof value === 'object' && value !== null
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default TaskExecutionBlock;
