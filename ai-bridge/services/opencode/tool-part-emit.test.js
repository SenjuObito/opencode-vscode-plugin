import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _handleToolPart } from './opencode-daemon-service.js';

/**
 * opencode 的 tool part 会经历多次 message.part.updated：
 *   pending      → state.input = ""            （空字符串，参数尚未解析）
 *   input.ended  → state.input = "<json 文本>" （仍是字符串）
 *   running 及之后 → state.input = { ... }       （真正的参数对象）
 *
 * 历史上 daemon 只在第一次 part.updated 时 emit tool_use 并用 toolUseDone
 * 锁死，导致前端永远收到 input:{} —— Edits 面板取不到 path（opencode 的
 * edit/write 用 `path` 字段），编辑列表恒为空。这些用例锁死「参数就绪后补发」
 * 的行为。
 */
function createTurn() {
  return {
    parts: new Map(),
    toolUseDone: new Set(),
    toolUseInput: new Map(),
    toolResultDone: new Set(),
  };
}

/** 捕获 emitToolUseMessage 写出的 [MESSAGE] 标记，返回其中的 tool_use input。 */
function collectToolUseInputs(run) {
  const emitted = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => {
    if (typeof line === 'string' && line.startsWith('[MESSAGE] ')) {
      const msg = JSON.parse(line.slice('[MESSAGE] '.length));
      for (const block of msg?.message?.content ?? []) {
        if (block.type === 'tool_use') emitted.push(block);
      }
    }
  };
  console.error = () => {};
  try {
    run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return emitted;
}

const EDIT_INPUT = { path: 'src/a.ts', oldString: 'foo', newString: 'bar' };

test('tool part — 参数在 running 状态就绪后补发带完整 input 的 tool_use', () => {
  const turn = createTurn();
  const part = { id: 'prt_1', callID: 'call_1', type: 'tool', tool: 'edit', state: {} };

  const emitted = collectToolUseInputs(() => {
    // 1) pending：input 是空字符串
    part.state = { status: 'pending', input: '' };
    _handleToolPart(part, turn);
    // 2) input.ended：input 仍是 JSON 字符串
    part.state = { status: 'pending', input: JSON.stringify(EDIT_INPUT) };
    _handleToolPart(part, turn);
    // 3) running：input 才是真正的参数对象
    part.state = { status: 'running', input: EDIT_INPUT };
    _handleToolPart(part, turn);
  });

  assert.equal(emitted.length, 2, '应发出 2 次：空参数占位 1 次 + 参数就绪补发 1 次');
  assert.deepEqual(emitted[0].input, {}, '首次发生时参数尚未解析，input 为空对象');
  assert.deepEqual(emitted[1].input, EDIT_INPUT, '补发必须带上完整参数（含 path）');
  // 宿主的 MessageMerger 按 block.id 原地替换，因此两次必须使用同一个 id
  assert.equal(emitted[0].id, emitted[1].id);
});

test('tool part — 参数首次就完整时只发一次，不重复补发', () => {
  const turn = createTurn();
  const part = {
    id: 'prt_1',
    callID: 'call_1',
    type: 'tool',
    tool: 'write',
    state: { status: 'running', input: { path: 'b.md', content: 'hi' } },
  };

  const emitted = collectToolUseInputs(() => {
    _handleToolPart(part, turn);
    _handleToolPart(part, turn);
    part.state = { status: 'completed', input: { path: 'b.md', content: 'hi' } };
    _handleToolPart(part, turn);
  });

  assert.equal(emitted.length, 1, '参数未变化时不应重复发射');
  assert.deepEqual(emitted[0].input, { path: 'b.md', content: 'hi' });
});

test('tool part — 参数就绪后不会被后续空值状态降级', () => {
  const turn = createTurn();
  const part = { id: 'prt_1', callID: 'call_1', type: 'tool', tool: 'edit', state: {} };

  const emitted = collectToolUseInputs(() => {
    part.state = { status: 'running', input: EDIT_INPUT };
    _handleToolPart(part, turn);
    // 模拟异常回退：后续 update 又把 input 置空
    part.state = { status: 'running', input: '' };
    _handleToolPart(part, turn);
  });

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].input, EDIT_INPUT, '已就绪的参数不应被空 input 覆盖');
});
