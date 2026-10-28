import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabId } from '../host/tab/TabId';

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];
	public raw: unknown[] = [];
	public disposed = false;

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return this.disposed;
	}

	public postRaw(message: unknown): void {
		this.raw.push(message);
	}

	public getViewCount(): number {
		return 1;
	}
}

function makeChatWindow(): ChatWindow {
	return new ChatWindow({
		settings: {} as never,
		daemon: {} as never,
		fileOps: {} as never,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
	});
}

/** 走 v2 命令信封，与 webview `sendHostCommand` 完全一致。 */
async function sendCommand(
	chatWindow: ChatWindow,
	viewId: string,
	type: string,
	tabId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await chatWindow.handleViewCommand(viewId, {
		v: 2,
		type,
		requestId: `${type}-${Math.random().toString(36).slice(2)}`,
		tabId,
		sessionId: null,
		payload,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * P9-A19：per-tab 的模型 / 推理力度 / 权限模式。
 *
 * 之前 webview 走 legacy 的 `set_model` / `set_reasoning_effort`，宿主把它们写进
 * **全局** context：tab A 换模型会连带改掉 tab B 的模型。这里验证 v2 的
 * `settings.model` / `settings.reasoning` / `settings.mode` 只写目标 tab。
 */
suite('P9-A19: per-tab 模型与推理力度', () => {
	test('settings.model 只写目标 tab，另一个 tab 的模型不变', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('view-1', view);

		const tabs = chatWindow.registry.liveTabs();
		assert.ok(tabs.length >= 1, '至少要有一个 tab');
		const tabA = tabs[0].getTabId().value;
		const tabB = tabs.length > 1 ? tabs[1].getTabId().value : tabA;

		await sendCommand(chatWindow, 'view-1', 'settings.model', tabA, { model: 'vendor/model-a' });

		const recordA = chatWindow.registry.get(TabId.of(tabA));
		const recordB = chatWindow.registry.get(TabId.of(tabB));
		assert.strictEqual(recordA?.getSettings().getModel(), 'vendor/model-a');
		if (tabB !== tabA) {
			assert.notStrictEqual(recordB?.getSettings().getModel(), 'vendor/model-a');
		}
	});

	test('settings.reasoning 只写目标 tab', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('view-1', view);

		const tabs = chatWindow.registry.liveTabs();
		const tabA = tabs[0].getTabId().value;
		const tabB = tabs.length > 1 ? tabs[1].getTabId().value : tabA;

		await sendCommand(chatWindow, 'view-1', 'settings.reasoning', tabA, { reasoningEffort: 'high' });

		assert.strictEqual(chatWindow.registry.get(TabId.of(tabA))?.getSettings().getReasoningEffort(), 'high');
		if (tabB !== tabA) {
			assert.notStrictEqual(chatWindow.registry.get(TabId.of(tabB))?.getSettings().getReasoningEffort(), 'high');
		}
	});

	test('settings.mode 只写目标 tab', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('view-1', view);

		const tabs = chatWindow.registry.liveTabs();
		const tabA = tabs[0].getTabId().value;
		const tabB = tabs.length > 1 ? tabs[1].getTabId().value : tabA;

		await sendCommand(chatWindow, 'view-1', 'settings.mode', tabA, { mode: 'plan' });

		assert.strictEqual(chatWindow.registry.get(TabId.of(tabA))?.getSettings().getPermissionMode(), 'plan');
		if (tabB !== tabA) {
			assert.notStrictEqual(chatWindow.registry.get(TabId.of(tabB))?.getSettings().getPermissionMode(), 'plan');
		}
	});

	test('缺 model / reasoningEffort 的载荷被忽略（不写空值）', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('view-1', view);

		const tabA = chatWindow.registry.liveTabs()[0].getTabId().value;
		const before = chatWindow.registry.get(TabId.of(tabA))?.getSettings().getModel();

		await sendCommand(chatWindow, 'view-1', 'settings.model', tabA, {});
		await sendCommand(chatWindow, 'view-1', 'settings.reasoning', tabA, {});

		assert.strictEqual(chatWindow.registry.get(TabId.of(tabA))?.getSettings().getModel(), before);
	});
});
