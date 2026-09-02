import { renderHook } from '@testing-library/react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { SubagentHistoryResponse } from '../types/subagent';
import {
  useFileChanges,
  computeDiffStats,
  clearDiffCache,
  parsePatchEditPairs,
} from './useFileChanges';

function lines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i}`).join('\n');
}

function assistantWithTools(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ClaudeMessage {
  return {
    type: 'assistant',
    content: '',
    raw: {
      role: 'assistant',
      content: tools.map((t) => ({
        type: 'tool_use',
        id: t.id,
        name: t.name,
        input: t.input,
      })),
    },
  } as ClaudeMessage;
}

function userWithResults(
  results: Array<{ toolUseId: string; isError?: boolean }>,
): ClaudeMessage {
  return {
    type: 'user',
    content: '',
    raw: {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        is_error: r.isError === true,
        content: r.isError ? 'error' : 'ok',
      })),
    },
  } as ClaudeMessage;
}

function getContentBlocks(message: ClaudeMessage): ClaudeContentBlock[] {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = (raw as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

function makeFindToolResult(messages: ClaudeMessage[]) {
  return (toolUseId?: string): ToolResultBlock | null => {
    if (!toolUseId) return null;
    for (const msg of messages) {
      const raw = msg.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = (raw as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const hit = content.find(
        (b): b is ToolResultBlock =>
          Boolean(b)
          && (b as ToolResultBlock).type === 'tool_result'
          && (b as ToolResultBlock).tool_use_id === toolUseId,
      );
      if (hit) return hit;
    }
    return null;
  };
}

describe('computeDiffStats', () => {
  beforeEach(() => {
    clearDiffCache();
  });

  it('counts equal-size large replacements as both additions and deletions', () => {
    const oldString = lines(120, 'old');
    const newString = lines(120, 'new');
    const stats = computeDiffStats(oldString, newString);
    expect(stats.additions).toBe(120);
    expect(stats.deletions).toBe(120);
  });

  it('counts large replacements that only change a few lines net correctly', () => {
    const oldLines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[10] = 'changed 10';
    newLines[11] = 'changed 11';
    newLines[12] = 'changed 12';
    // net +0 lines, but 3 replaced
    const stats = computeDiffStats(oldLines.join('\n'), newLines.join('\n'));
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(3);
  });

  it('does not collide cache keys for same-length different content', () => {
    const prefix = 'x'.repeat(50);
    const oldA = `${prefix}AAA${'y'.repeat(50)}`;
    const newA = `${prefix}BBB${'y'.repeat(50)}`;
    const oldB = `${prefix}CCC${'y'.repeat(50)}`;
    const newB = `${prefix}DDD${'y'.repeat(50)}`;

    const statsA = computeDiffStats(oldA, newA);
    const statsB = computeDiffStats(oldB, newB);

    // Both are single-line full replacements → each should be +1 -1
    expect(statsA).toEqual({ additions: 1, deletions: 1 });
    expect(statsB).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts write-style empty old as pure additions', () => {
    expect(computeDiffStats('', 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 });
  });
});

describe('useFileChanges', () => {
  beforeEach(() => {
    clearDiffCache();
  });

  it('aggregates multiple successful Edit tools into separate file entries', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'e1',
          name: 'Edit',
          input: { file_path: '/proj/a.ts', old_string: 'a', new_string: 'A' },
        },
        {
          id: 'e2',
          name: 'Edit',
          input: { file_path: '/proj/b.ts', old_string: 'b', new_string: 'B' },
        },
        {
          id: 'e3',
          name: 'Write',
          input: { file_path: '/proj/c.ts', content: 'hello\nworld' },
        },
        {
          id: 'e4',
          name: 'Edit',
          input: { file_path: '/proj/d.ts', old_string: 'd1\nd2', new_string: 'D1' },
        },
      ]),
      userWithResults([
        { toolUseId: 'e1' },
        { toolUseId: 'e2' },
        { toolUseId: 'e3' },
        { toolUseId: 'e4' },
      ]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(4);
    const paths = result.current.map((f) => f.filePath).sort();
    expect(paths).toEqual(['/proj/a.ts', '/proj/b.ts', '/proj/c.ts', '/proj/d.ts']);
  });

  it('includes MultiEdit tool and expands edits[] for stats', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'm1',
          name: 'MultiEdit',
          input: {
            file_path: '/proj/multi.ts',
            edits: [
              { old_string: 'foo', new_string: 'bar' },
              { old_string: 'one\ntwo', new_string: 'ONE' },
            ],
          },
        },
      ]),
      userWithResults([{ toolUseId: 'm1' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    const file = result.current[0];
    expect(file.filePath).toBe('/proj/multi.ts');
    // edit1: +1 -1, edit2: +1 -2 → totals +2 -3
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(3);
    expect(file.operations).toHaveLength(2);
  });

  it('counts large equal-line Edit stats correctly in the hook', () => {
    const oldString = lines(110, 'old');
    const newString = lines(110, 'new');
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'big',
          name: 'Edit',
          input: { file_path: '/proj/big.ts', old_string: oldString, new_string: newString },
        },
      ]),
      userWithResults([{ toolUseId: 'big' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current[0].additions).toBe(110);
    expect(result.current[0].deletions).toBe(110);
  });

  it('includes successful Edit tools from subagent histories', () => {
    const mainMessages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'agent-1',
          name: 'Agent',
          input: { description: 'edit files', prompt: 'go', subagent_type: 'general-purpose' },
        },
      ]),
      userWithResults([{ toolUseId: 'agent-1' }]),
    ];

    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      'agent-1': {
        success: true,
        toolUseId: 'agent-1',
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'sub-edit-1',
                  name: 'Edit',
                  input: {
                    file_path: '/proj/from-agent.ts',
                    old_string: 'x',
                    new_string: 'y',
                  },
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'sub-edit-1',
                  content: 'ok',
                },
              ],
            },
          },
        ],
      },
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: mainMessages,
        getContentBlocks,
        findToolResult: makeFindToolResult(mainMessages),
        subagentHistories,
      }),
    );

    expect(result.current.map((f) => f.filePath)).toContain('/proj/from-agent.ts');
  });

  it('skips failed tool results', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'ok',
          name: 'Edit',
          input: { file_path: '/proj/ok.ts', old_string: 'a', new_string: 'b' },
        },
        {
          id: 'fail',
          name: 'Edit',
          input: { file_path: '/proj/fail.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
      userWithResults([
        { toolUseId: 'ok' },
        { toolUseId: 'fail', isError: true },
      ]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/proj/ok.ts');
  });
});

describe('parsePatchEditPairs (apply_patch)', () => {
  it('parses Update File hunks into reversible old/new pairs', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      ' context line',
      '-old one',
      '+new one',
      '+new two',
      '@@',
      ' more context',
      '-gone',
      '+back',
      '*** End Patch',
    ].join('\n');

    const pairs = parsePatchEditPairs(patch);
    expect(pairs).toHaveLength(2);

    expect(pairs[0]).toEqual({
      oldString: 'context line\nold one',
      newString: 'context line\nnew one\nnew two',
      filePath: 'src/a.ts',
    });
    expect(pairs[1]).toEqual({
      oldString: 'more context\ngone',
      newString: 'more context\nback',
      filePath: 'src/a.ts',
    });
  });

  it('parses Add File as an empty-old pair and Delete File as a delete marker', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const a = 1;',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');

    const pairs = parsePatchEditPairs(patch);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ oldString: '', newString: 'export const a = 1;', filePath: 'src/new.ts' });
    expect(pairs[1]).toMatchObject({ oldString: '', newString: '', filePath: 'src/old.ts', kind: 'delete-file' });
  });

  it('counts apply_patch changes in useFileChanges (regression for missing files)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /proj/patched.ts',
      '@@',
      '-const a = 1;',
      '+const a = 2;',
      '*** End Patch',
    ].join('\n');

    const messages: ClaudeMessage[] = [
      assistantWithTools([
        { id: 'p1', name: 'apply_patch', input: { input: patch } },
      ]),
      userWithResults([{ toolUseId: 'p1' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/proj/patched.ts');
    expect(result.current[0].additions).toBe(1);
    expect(result.current[0].deletions).toBe(1);
  });
});
