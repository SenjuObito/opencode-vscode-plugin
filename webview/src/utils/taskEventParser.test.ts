import { describe, expect, it } from 'vitest';
import { isTaskEventForSession, parseSubagentStatusEvent, parseTaskNotification } from './taskEventParser';

describe('parseTaskNotification', () => {
  it('parses a complete task_notification with usage', () => {
    const ev = parseTaskNotification({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'af5a83aa',
      tool_use_id: 'tu_1',
      status: 'completed',
      summary: '调研完成',
      output_file: '/tmp/agent.jsonl',
      usage: { total_tokens: 4200, tool_uses: 7, duration_ms: 18000 },
    });

    expect(ev).toEqual({
      toolUseId: 'tu_1',
      agentId: 'af5a83aa',
      status: 'completed',
      summary: '调研完成',
      totalTokens: 4200,
      totalToolUseCount: 7,
      totalDurationMs: 18000,
      outputFilePath: '/tmp/agent.jsonl',
    });
  });

  it('ignores input_tokens/output_tokens (not part of the task_notification schema)', () => {
    // Claude Code's task_notification usage only carries total_tokens /
    // tool_uses / duration_ms (sdkEventQueue.ts TaskNotificationSdkEvent and
    // print.ts's XML parser are the only emit sites). input_tokens /
    // output_tokens are never present, so the parser must not synthesize
    // totalTokens from them - it should read total_tokens alone.
    const ev = parseTaskNotification({
      subtype: 'task_notification',
      tool_use_id: 'tu_2',
      status: 'completed',
      usage: { total_tokens: 1500, tool_uses: 2, duration_ms: 9000 },
    });

    expect(ev?.totalTokens).toBe(1500);
    expect(ev?.totalToolUseCount).toBe(2);
    expect(ev?.totalDurationMs).toBe(9000);
  });

  it('leaves usage fields undefined when usage is missing', () => {
    const ev = parseTaskNotification({
      subtype: 'task_notification',
      tool_use_id: 'tu_3',
      status: 'failed',
    });

    expect(ev?.status).toBe('failed');
    expect(ev?.totalTokens).toBeUndefined();
    expect(ev?.totalToolUseCount).toBeUndefined();
    expect(ev?.totalDurationMs).toBeUndefined();
    expect(ev?.summary).toBeUndefined();
    expect(ev?.agentId).toBeUndefined();
    expect(ev?.outputFilePath).toBeUndefined();
  });

  it('returns null for non-task_notification subtypes', () => {
    expect(parseTaskNotification({ subtype: 'task_started', tool_use_id: 'tu', status: 'completed' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_progress', tool_use_id: 'tu', status: 'completed' })).toBeNull();
  });

  it('returns null when tool_use_id or status is missing', () => {
    expect(parseTaskNotification({ subtype: 'task_notification', status: 'completed' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: '', status: 'completed' })).toBeNull();
  });

  it('returns null for malformed payloads', () => {
    expect(parseTaskNotification(null)).toBeNull();
    expect(parseTaskNotification(undefined)).toBeNull();
    expect(parseTaskNotification('not-an-object')).toBeNull();
    expect(parseTaskNotification({})).toBeNull();
  });

  it('passes stopped status through for the caller to map', () => {
    // parseTaskNotification does not interpret status; determineStatus maps
    // stopped/failed -> error. Verify the raw status survives so that mapping
    // can fire.
    const ev = parseTaskNotification({
      subtype: 'task_notification',
      tool_use_id: 'tu_4',
      status: 'stopped',
    });
    expect(ev?.status).toBe('stopped');
  });

  it('rejects status values outside the SDK enum', () => {
    // SDK only emits 'completed' | 'failed' | 'stopped' (sdkEventQueue.ts
    // emitTaskTerminatedSdk; print.ts maps XML 'killed' -> 'stopped'). An
    // unexpected value must not slip through the type system and masquerade
    // as a known terminal status downstream.
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu', status: 'running' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu', status: 'killed' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu', status: 'pending' })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu', status: 42 })).toBeNull();
    expect(parseTaskNotification({ subtype: 'task_notification', tool_use_id: 'tu', status: null })).toBeNull();
  });

  it('treats an empty output_file as no path', () => {
    // The SDK defaults output_file to '' when no sidechain transcript was
    // produced (sdkEventQueue.ts emitTaskTerminatedSdk). '' is not a usable
    // path and would diverge from undefined across the dual delivery paths'
    // dedup, so the parser coalesces it to undefined.
    const ev = parseTaskNotification({
      subtype: 'task_notification',
      tool_use_id: 'tu',
      status: 'completed',
      output_file: '',
    });
    expect(ev?.outputFilePath).toBeUndefined();
  });
});

describe('parseSubagentStatusEvent', () => {
  it('maps core subagent.status onto the canonical TaskEvent shape', () => {
    expect(parseSubagentStatusEvent({
      parentSessionId: 'ses_parent',
      toolUseId: 'call_1',
      childSessionId: 'ses_child',
      status: 'completed',
      description: '查找 liyibo',
      summary: '没有找到',
    })).toEqual({
      toolUseId: 'call_1',
      status: 'completed',
      agentId: 'ses_child',
      summary: '没有找到',
    });
  });

  it('keeps failed/stopped terminal statuses for the shared mapper', () => {
    expect(parseSubagentStatusEvent({ toolUseId: 'call_1', status: 'failed' })?.status).toBe('failed');
    expect(parseSubagentStatusEvent({ toolUseId: 'call_1', status: 'stopped' })?.status).toBe('stopped');
  });

  it('rejects non-terminal and malformed payloads', () => {
    expect(parseSubagentStatusEvent({ toolUseId: 'call_1', status: 'running' })).toBeNull();
    expect(parseSubagentStatusEvent({ toolUseId: 'call_1', status: 'weird' })).toBeNull();
    expect(parseSubagentStatusEvent({ status: 'completed' })).toBeNull();
    expect(parseSubagentStatusEvent(null)).toBeNull();
    expect(parseSubagentStatusEvent('completed')).toBeNull();
  });

  it('omits optional fields when core did not provide them', () => {
    expect(parseSubagentStatusEvent({ toolUseId: 'call_1', status: 'completed' })).toEqual({
      toolUseId: 'call_1',
      status: 'completed',
    });
  });
});

describe('isTaskEventForSession', () => {
  it('宿主打了 sessionId 时只放行同一会话', () => {
    expect(isTaskEventForSession({ sessionId: 'ses_a' }, 'ses_a')).toBe(true);
    expect(isTaskEventForSession({ sessionId: 'ses_b' }, 'ses_a')).toBe(false);
  });

  it('没有 sessionId 的旧载荷一律放行', () => {
    expect(isTaskEventForSession({ subtype: 'task_notification' }, 'ses_a')).toBe(true);
    expect(isTaskEventForSession(null, 'ses_a')).toBe(true);
  });

  it('当前会话还不知道时，带 id 的事件按不匹配处理', () => {
    expect(isTaskEventForSession({ sessionId: 'ses_a' }, null)).toBe(false);
    expect(isTaskEventForSession({ sessionId: '' }, null)).toBe(true);
  });
});
