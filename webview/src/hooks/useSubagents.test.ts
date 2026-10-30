import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../types';
import { extractSubagentsFromMessages } from './useSubagents';

const assistantWithAgent = (toolUseId: string): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  raw: {
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'research',
            description: '分析后端历史索引服务的设计模式',
            prompt: '分析 ClaudeHistoryIndexService',
          },
        },
      ],
    },
  },
});

const toolResultMessage = (toolUseId: string): ClaudeMessage => ({
  type: 'user',
  content: '',
  raw: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: 'final report' }],
      },
    ],
    toolUseResult: {
      status: 'completed',
      agentId: 'af5a83aa15ca39691',
      agentType: 'research',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
      toolStats: { readCount: 4, searchCount: 0 },
    },
  } as any,
});

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content.filter((block): block is ClaudeContentBlock => block.type === 'tool_use') : [];
};

const findToolResult = (messages: ClaudeMessage[]) => (toolUseId?: string): ToolResultBlock | null => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content)) continue;
    const result = content.find((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === toolUseId);
    if (result) return result;
  }
  return null;
};

const getToolResultRaw = (messages: ClaudeMessage[]) => (toolUseId: string) => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result' && (block as ToolResultBlock).tool_use_id === toolUseId)) {
      return raw as Record<string, unknown>;
    }
  }
  return null;
};

describe('extractSubagentsFromMessages', () => {
  it('retains Codex spawn_agent path metadata for history requests', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: '',
      raw: {
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-spawn',
            name: 'spawn_agent',
            input: { task_name: 'audit_ui', message: 'Review anchors' },
          }],
        },
      },
    };

    const subagents = extractSubagentsFromMessages(
      [message], getContentBlocks, findToolResult([message]), getToolResultRaw([message]),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'call-spawn',
      agentPath: 'audit_ui',
      isAsync: true,
      status: 'running',
    });
  });

  it('attaches completed Agent result metadata including stable agent id', () => {
    const messages = [assistantWithAgent('tooluse_backend'), toolResultMessage('tooluse_backend')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tooluse_backend',
      agentId: 'af5a83aa15ca39691',
      type: 'research',
      description: '分析后端历史索引服务的设计模式',
      status: 'completed',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
    });
    expect(subagents[0].toolStats).toMatchObject({ readCount: 4 });
  });

  const assistantWithAsyncAgent = (toolUseId: string): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: {
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Agent',
            input: {
              subagent_type: 'research',
              description: '后台调研 subagent',
              prompt: '调研索引服务设计模式',
              run_in_background: true,
            },
          },
        ],
      },
    },
  });

  // Async agent (Agent tool with run_in_background:true) only gets a launch
  // acknowledgment tool_result; the terminal status arrives later via a
  // task_notification event.
  const launchAckResult = (toolUseId: string): ClaudeMessage => ({
    type: 'user',
    content: '',
    raw: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Async agent launched successfully.',
        },
      ],
    } as any,
  });

  it('keeps async agent running while only the launch ack has landed', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('running');
  });

  it('completes async agent from its task_notification with event-derived metadata', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];
    const taskEvents = {
      tu_spawn: {
        toolUseId: 'tu_spawn',
        status: 'completed' as const,
        summary: '后台调研完成,发现 3 处索引模式',
        totalTokens: 4200,
        totalToolUseCount: 7,
        totalDurationMs: 18000,
      },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tu_spawn',
      status: 'completed',
      resultText: '后台调研完成,发现 3 处索引模式',
      totalTokens: 4200,
      totalToolUseCount: 7,
      totalDurationMs: 18000,
    });
  });

  it('marks async agent as error when task_notification reports failure', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn')];
    const taskEvents = {
      tu_spawn: { toolUseId: 'tu_spawn', status: 'failed' as const },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('error');
  });

  it('marks a failed async launch as error when the ack tool_result is is_error', () => {
    // A validation failure (e.g. "In-process teammates cannot spawn background
    // agents") returns an is_error tool_result before the background task is
    // registered, so no task_notification ever follows - the agent must surface
    // as error, not stay stuck on "running".
    const messages: ClaudeMessage[] = [
      assistantWithAsyncAgent('tu_launch_fail'),
      {
        type: 'user',
        content: '',
        raw: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_launch_fail',
              content: 'In-process teammates cannot spawn background agents',
              is_error: true,
            },
          ],
        } as any,
      },
    ];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('error');
  });

  // opencode v2 renamed the v1 `task` tool to `subagent`, its type argument to
  // `agent`, and its async switch to `background`. The status panel must accept
  // the v2 shape without an engine branch.
  const assistantWithV2Subagent = (
    toolUseId: string,
    background = true,
  ): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: {
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'subagent',
            input: {
              agent: 'explore',
              description: '查找 liyibo 相关信息',
              prompt: '在仓库中查找 liyibo',
              ...(background ? { background: true } : {}),
            },
          },
        ],
      },
    },
  });

  it('recognizes opencode v2 subagent and reads its agent type', () => {
    const messages = [assistantWithV2Subagent('tu_v2')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tu_v2',
      type: 'explore',
      description: '查找 liyibo 相关信息',
      isAsync: true,
      status: 'running',
    });
  });

  it('completes a v2 subagent from core subagent.status, not a transcript', () => {
    const messages = [assistantWithV2Subagent('tu_v2'), launchAckResult('tu_v2')];
    const taskEvents = {
      tu_v2: { toolUseId: 'tu_v2', status: 'completed' as const, agentId: 'ses_child' },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tu_v2',
      status: 'completed',
      agentId: 'ses_child',
    });
  });

  it('leaves a background v2 subagent running while only the launch ack has landed', () => {
    const messages = [assistantWithV2Subagent('tu_v2'), launchAckResult('tu_v2')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('running');
  });
});
