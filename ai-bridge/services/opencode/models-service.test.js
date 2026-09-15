import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSdkModelEntry,
  parseOpenCodeModelsOutput,
  resolveContextWindow,
} from './models-service.js';

test('parses provider/model lines and dedups', () => {
  const out = 'opencode/big-pickle\nanthropic/claude-fable-5\nopencode/big-pickle\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-fable-5']);
  // UI groups by provider prefix, so the label carries the model name only.
  assert.equal(models[0].label, 'Big-Pickle');
});

test('legacy stdout fallback carries no context window', () => {
  const models = parseOpenCodeModelsOutput('deepseek/deepseek-v4-pro\n');
  assert.equal('contextWindow' in models[0], false);
});

test('resolveContextWindow reads models.dev limit.context', () => {
  assert.equal(resolveContextWindow({ limit: { context: 1000000, output: 384000 } }), 1000000);
  assert.equal(resolveContextWindow({ limit: { context: 1048576 } }), 1048576);
});

test('resolveContextWindow ignores missing or nonsense limits', () => {
  assert.equal(resolveContextWindow(undefined), undefined);
  assert.equal(resolveContextWindow({}), undefined);
  assert.equal(resolveContextWindow({ limit: {} }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: 0 } }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: -1 } }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: 'nope' } }), undefined);
  // limit.output alone is not a context window.
  assert.equal(resolveContextWindow({ limit: { output: 32000 } }), undefined);
});

test('buildSdkModelEntry carries contextWindow through to the catalog entry', () => {
  const entry = buildSdkModelEntry('deepseek', 'DeepSeek', 'deepseek-v4-pro', {
    name: 'DeepSeek V4 Pro',
    limit: { context: 1000000, output: 384000 },
  });
  assert.deepEqual(entry, {
    id: 'deepseek/deepseek-v4-pro',
    label: 'Deepseek-V4-Pro',
    description: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
  });
});

test('buildSdkModelEntry omits contextWindow when the limit is unknown', () => {
  const entry = buildSdkModelEntry('opencode', 'opencode', 'big-pickle', {});
  assert.equal('contextWindow' in entry, false);
  assert.equal(entry.description, 'opencode big-pickle');
});

test('buildSdkModelEntry keeps variants alongside the context window', () => {
  const entry = buildSdkModelEntry('anthropic', 'Anthropic', 'claude-sonnet-5', {
    variants: { high: {}, low: {}, disabledOne: { disabled: true } },
    limit: { context: 200000 },
  });
  assert.deepEqual(entry.variants, ['high', 'low']);
  assert.equal(entry.contextWindow, 200000);
});
