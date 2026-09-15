import * as assert from 'assert';

import { ModelProviderHandler } from '../host/handlers/ModelProviderHandler';
import { HandlerContext } from '../host/router/HandlerContext';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { SettingsService } from '../host/settings/SettingsService';
import type { SettingsStore } from '../host/settings/SettingsService';
import type { OpenCodeSession } from '../host/session/OpenCodeSession';

/**
 * `set_model` 的用量环副作用回归测试。
 *
 * 上下文额度是模型自身的属性：切换模型后必须按新模型重推一次用量环，否则分母会
 * 停在旧模型上（1M 的模型切过去仍显示 200k），直到下一轮 usage 事件才纠正。
 * 参考实现 opencode-idea-gui 的 ModelProviderHandler.handleSetModel 同样在
 * modelChanged 时 clearUsageDisplay + pushUsageUpdateAfterModelChange。
 */

interface Call {
	fn: string;
	args: string[];
}

function memoryStore(): SettingsStore {
	const global = new Map<string, unknown>();
	const workspace = new Map<string, unknown>();
	return {
		getGlobal: (key) => global.get(key),
		setGlobal: (key, value) => void global.set(key, value),
		getWorkspace: (key) => workspace.get(key),
		setWorkspace: (key, value) => void workspace.set(key, value),
	};
}

/**
 * 假的 OpenCodeSession：只保留 set_model 需要触碰的两个成员，并记录重推发生时
 * session 里已经是哪个模型（顺序错了就会解析出旧额度）。
 */
function fakeSession(initialModel: string) {
	let model = initialModel;
	const republishes: string[] = [];
	return {
		session: {
			state: {
				getModel: () => model,
				setModel: (next: string) => {
					model = next;
				},
			},
			republishUsageAfterModelChange: () => {
				republishes.push(model);
			},
		} as unknown as OpenCodeSession,
		republishes,
		modelNow: () => model,
	};
}

function makeHandler(session: OpenCodeSession | null) {
	const calls: Call[] = [];
	const channel: WebviewChannel = {
		// 载荷可能是裸字符串（onModelConfirmed 的 model），不能无条件 JSON.parse。
		callJavaScript: (fn, ...args) => {
			calls.push({ fn, args });
		},
		isDisposed: () => false,
		postRaw: () => {},
	};
	const context = new HandlerContext(channel, new SettingsService(memoryStore()));
	if (session) {
		context.setSession(session);
	}
	// currentModel 故意留空：真实初始化路径下 session/context 都还没有模型。
	return { handler: new ModelProviderHandler(context), calls, context };
}

suite('ModelProviderHandler set_model usage refresh', () => {
	test('a real model switch republishes usage under the new model', () => {
		const fake = fakeSession('opencode/big-pickle');
		const { handler } = makeHandler(fake.session);

		handler.handle('set_model', 'deepseek/deepseek-v4-pro');

		assert.strictEqual(fake.modelNow(), 'deepseek/deepseek-v4-pro');
		// 顺序保证：重推时 session 里必须已经是新模型，否则额度解析用的是旧值。
		assert.deepStrictEqual(fake.republishes, ['deepseek/deepseek-v4-pro']);
	});

	test('accepts the JSON payload form the webview uses', () => {
		const fake = fakeSession('opencode/big-pickle');
		const { handler } = makeHandler(fake.session);

		handler.handle('set_model', JSON.stringify({ model: 'deepseek/deepseek-v4-pro' }));

		assert.strictEqual(fake.modelNow(), 'deepseek/deepseek-v4-pro');
		assert.deepStrictEqual(fake.republishes, ['deepseek/deepseek-v4-pro']);
	});

	test('re-confirming the same model is a no-op', () => {
		const fake = fakeSession('deepseek/deepseek-v4-pro');
		const { handler } = makeHandler(fake.session);

		handler.handle('set_model', 'deepseek/deepseek-v4-pro');

		assert.deepStrictEqual(fake.republishes, []);
	});

	test('initializing a session that has no model yet does not republish', () => {
		const fake = fakeSession('');
		const { handler } = makeHandler(fake.session);

		handler.handle('set_model', 'deepseek/deepseek-v4-pro');

		assert.strictEqual(fake.modelNow(), 'deepseek/deepseek-v4-pro');
		// 首次初始化没有可比对的旧模型，不触发重推（isActualModelSwitch 语义）。
		assert.deepStrictEqual(fake.republishes, []);
	});

	test('an empty model does not touch the usage ring', () => {
		const fake = fakeSession('opencode/big-pickle');
		const { handler } = makeHandler(fake.session);

		handler.handle('set_model', '');

		assert.deepStrictEqual(fake.republishes, []);
	});

	test('still confirms the model to the webview when no session is attached', () => {
		const { handler, calls } = makeHandler(null);

		handler.handle('set_model', 'deepseek/deepseek-v4-pro');

		const confirmed = calls.find((c) => c.fn === 'onModelConfirmed');
		assert.ok(confirmed, 'expected onModelConfirmed');
		assert.strictEqual(confirmed.args[0], 'deepseek/deepseek-v4-pro');
	});
});
