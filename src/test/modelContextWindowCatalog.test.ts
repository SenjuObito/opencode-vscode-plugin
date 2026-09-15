import * as assert from 'assert';

import {
	__resetModelContextWindowCatalogForTests,
	getCatalogContextWindow,
	updateModelContextWindows,
} from '../host/util/ModelContextWindowCatalog';
import { getModelContextLimit } from '../host/util/ModelContextLimits';

/**
 * 模型上下文额度回归测试。
 *
 * opencode 目录里的 models.dev `limit.context` 必须一路带到 host 侧，否则用量环
 * 会退回硬编码表的 200k 默认值 —— 1M 的 deepseek-v4-pro 因此被显示成 200k。
 */
suite('Model context window catalog', () => {
	setup(() => {
		__resetModelContextWindowCatalogForTests();
	});

	teardown(() => {
		__resetModelContextWindowCatalogForTests();
	});

	test('resolves qualified and bare model ids', () => {
		const changed = updateModelContextWindows({
			models: [
				{ id: 'deepseek/deepseek-v4-pro', contextWindow: 1000000 },
				{ id: 'opencode/big-pickle', contextWindow: 200000 },
			],
		});

		assert.strictEqual(changed, true);
		assert.strictEqual(getCatalogContextWindow('deepseek/deepseek-v4-pro'), 1000000);
		assert.strictEqual(getCatalogContextWindow('deepseek-v4-pro'), 1000000);
		assert.strictEqual(getCatalogContextWindow('  opencode/big-pickle  '), 200000);
	});

	test('ignores entries without a usable context window', () => {
		const changed = updateModelContextWindows({
			models: [
				{ id: 'no-limit' },
				{ id: 'zero', contextWindow: 0 },
				{ id: 'negative', contextWindow: -1 },
				{ id: 'textual', contextWindow: 'nope' },
				{ id: 'fractional', contextWindow: 1.5 },
				{ contextWindow: 1000000 },
				null,
				'x',
			],
		});

		assert.strictEqual(changed, false);
		assert.strictEqual(getCatalogContextWindow('no-limit'), undefined);
		assert.strictEqual(getCatalogContextWindow('zero'), undefined);
		assert.strictEqual(getCatalogContextWindow('negative'), undefined);
		assert.strictEqual(getCatalogContextWindow('textual'), undefined);
		// 1.5 是非法额度，必须截断成 1 之前先被拒掉，不能悄悄变成 1。
		assert.strictEqual(getCatalogContextWindow('fractional'), undefined);
	});

	test('tolerates malformed payloads', () => {
		assert.strictEqual(updateModelContextWindows(null), false);
		assert.strictEqual(updateModelContextWindows({}), false);
		assert.strictEqual(updateModelContextWindows({ models: {} }), false);
		assert.strictEqual(updateModelContextWindows('nope'), false);
	});

	test('reports only real changes', () => {
		const first = { models: [{ id: 'vendor/m', contextWindow: 200000 }] };
		assert.strictEqual(updateModelContextWindows(first), true);
		// Same payload again teaches nothing new.
		assert.strictEqual(updateModelContextWindows(first), false);

		assert.strictEqual(
			updateModelContextWindows({ models: [{ id: 'vendor/m', contextWindow: 1000000 }] }),
			true,
		);
		assert.strictEqual(getCatalogContextWindow('vendor/m'), 1000000);
	});

	test('keeps earlier knowledge when a later payload has no limits', () => {
		updateModelContextWindows({ models: [{ id: 'vendor/m', contextWindow: 1000000 }] });

		// The legacy `opencode models` fallback carries no window — it must not
		// erase what the richer SDK payload already taught us.
		assert.strictEqual(updateModelContextWindows({ models: [{ id: 'vendor/m', label: 'M' }] }), false);
		assert.strictEqual(getCatalogContextWindow('vendor/m'), 1000000);
	});

	test('does not resolve explicit capacity suffixes', () => {
		updateModelContextWindows({ models: [{ id: 'vendor/m', contextWindow: 200000 }] });

		// `[1m]` is an explicit user choice; the suffix parser must win.
		assert.strictEqual(getCatalogContextWindow('vendor/m[1m]'), undefined);
	});
});

suite('getModelContextLimit resolution order', () => {
	setup(() => {
		__resetModelContextWindowCatalogForTests();
	});

	teardown(() => {
		__resetModelContextWindowCatalogForTests();
	});

	test('catalog beats the hardcoded 200k fallback for unknown models', () => {
		updateModelContextWindows({
			models: [{ id: 'deepseek/deepseek-v4-pro', contextWindow: 1000000 }],
		});

		assert.strictEqual(getModelContextLimit('deepseek/deepseek-v4-pro'), 1000000);
		assert.strictEqual(getModelContextLimit('deepseek-v4-pro'), 1000000);
	});

	test('catalog beats the hardcoded table for models both know', () => {
		// gpt-5 is pinned at 400k in the table; live metadata says otherwise.
		updateModelContextWindows({ models: [{ id: 'openai/gpt-5', contextWindow: 500000 }] });

		assert.strictEqual(getModelContextLimit('openai/gpt-5'), 500000);
	});

	test('explicit capacity suffix beats the catalog', () => {
		updateModelContextWindows({ models: [{ id: 'vendor/m', contextWindow: 200000 }] });

		assert.strictEqual(getModelContextLimit('vendor/m[1m]'), 1000000);
		assert.strictEqual(getModelContextLimit('vendor/m[200k]'), 200000);
		assert.strictEqual(getModelContextLimit('vendor/m'), 200000);
	});

	test('a cold catalog still falls back to the hardcoded table', () => {
		assert.strictEqual(getModelContextLimit('gpt-5'), 400000);
		assert.strictEqual(getModelContextLimit('gpt-4o'), 128000);
		assert.strictEqual(getModelContextLimit('deepseek-v4-pro'), 200000);
		assert.strictEqual(getModelContextLimit(null), 200000);
		assert.strictEqual(getModelContextLimit(''), 200000);
	});
});
