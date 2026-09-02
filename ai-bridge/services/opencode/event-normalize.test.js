import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePermissionRequest,
  normalizeQuestionRequest,
} from './event-normalize.js';

const QUESTION = {
  question: '请选择项目类型',
  header: '项目类型',
  multiple: false,
  custom: true,
  options: [
    { label: 'NSFC', description: '国家自然科学基金' },
    { label: '其他', description: '' },
  ],
};

test('normalizeQuestionRequest — v1 shape (fields on properties)', () => {
  const result = normalizeQuestionRequest({
    id: 'qst_1',
    sessionID: 'ses_1',
    questions: [QUESTION],
    tool: { messageID: 'msg_1', callID: 'call_1' },
  });
  assert.equal(result.type, 'question');
  assert.equal(result.sessionId, 'ses_1');
  assert.equal(result.requestId, 'qst_1');
  assert.equal(result.tool, 'call_1');
  assert.equal(result.questions.length, 1);
  assert.deepEqual(result.questions[0], {
    question: '请选择项目类型',
    header: '项目类型',
    multiSelect: false,
    custom: true,
    options: QUESTION.options,
  });
});

test('normalizeQuestionRequest — v2 shape (nested data)', () => {
  const result = normalizeQuestionRequest({
    data: { id: 'qst_2', sessionID: 'ses_2', questions: [{ ...QUESTION, multiple: true }] },
  });
  assert.equal(result.sessionId, 'ses_2');
  assert.equal(result.requestId, 'qst_2');
  assert.equal(result.questions[0].multiSelect, true);
});

test('normalizeQuestionRequest — custom defaults to true when omitted', () => {
  const result = normalizeQuestionRequest({
    id: 'qst_3',
    sessionID: 'ses_3',
    questions: [{ ...QUESTION, custom: undefined }],
  });
  assert.equal(result.questions[0].custom, true);
});

test('normalizeQuestionRequest — missing/invalid questions yields empty array', () => {
  for (const props of [undefined, {}, { id: 'qst_4' }, { questions: 'nope' }]) {
    const result = normalizeQuestionRequest(props);
    assert.deepEqual(result.questions, []);
    assert.equal(result.type, 'question');
  }
});

test('normalizePermissionRequest — v1 shape (patterns on properties)', () => {
  const result = normalizePermissionRequest({
    id: 'perm_1',
    sessionID: 'ses_1',
    permission: 'edit',
    patterns: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(result.type, 'permission');
  assert.equal(result.permissionId, 'perm_1');
  assert.equal(result.sessionId, 'ses_1');
  assert.equal(result.tool, 'edit');
  assert.equal(result.description, 'src/a.ts, src/b.ts');
});

test('normalizePermissionRequest — v2 shape (nested data with resources)', () => {
  const result = normalizePermissionRequest({
    data: { id: 'perm_2', sessionID: 'ses_2', action: 'bash', resources: ['ls'] },
  });
  assert.equal(result.permissionId, 'perm_2');
  assert.equal(result.tool, 'bash');
  assert.equal(result.description, 'ls');
});

test('normalizePermissionRequest — carries the originating tool callID', () => {
  // opencode attaches data.tool.callID; the webview needs it to anchor the
  // card to the exact tool_use block instead of guessing by action name.
  const result = normalizePermissionRequest({
    data: {
      id: 'perm_3',
      sessionID: 'ses_3',
      permission: 'bash',
      patterns: ['ls'],
      tool: { messageID: 'msg_3', callID: 'call_3' },
    },
  });
  assert.equal(result.tool, 'bash');
  assert.equal(result.toolUseId, 'call_3');
  assert.equal(result.tool_use_id, 'call_3');
});

test('normalizePermissionRequest — falls back to permissionId without a tool call', () => {
  const result = normalizePermissionRequest({
    data: { id: 'perm_4', sessionID: 'ses_4', permission: 'bash' },
  });
  assert.equal(result.toolUseId, 'perm_4');
  assert.equal(result.tool_use_id, 'perm_4');
});
