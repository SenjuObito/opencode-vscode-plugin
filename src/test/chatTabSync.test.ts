import * as assert from 'assert';

import { HandlerContext, type WebviewChannel } from '../host/router/HandlerContext';
import { ViewRegistry } from '../host/router/ViewRegistry';
import { MessageDispatcher } from '../host/router/MessageDispatcher';
import { ChatTabHandler } from '../host/handlers/ChatTabHandler';
import { ChatTabStore } from '../host/tabs/ChatTabStore';
import { SettingsService, type SettingsStore } from '../host/settings/SettingsService';

/**
 * 标签栏是全局状态：一个窗口的新建 / 关闭 / 切换必须让其余窗口跟上。
 *
 * 这组用例守住三条契约：
 *   1. `sync_tabs` 落盘后**广播**给所有视图（不只是发起者）；
 *   2. `get_tabs` 只回给**发起的那个视图**（视图挂载时索取自己的副本）；
 *   3. 宿主没有存档时不向下发空列表，由视图用本地标签做种子。
 */

class FakeView implements WebviewChannel {
	readonly calls: Array<{ fn: string; args: string[] }> = [];
	disposed = false;

	constructor(readonly id: string) {}

	callJavaScript(fn: string, ...args: string[]): void {
		this.calls.push({ fn, args });
	}
	postRaw(): void {}
	isDisposed(): boolean {
		return this.disposed;
	}
	getViewCount(): number {
		return this.disposed ? 0 : 1;
	}
	lastCall(fn: string): { fn: string; args: string[] } | undefined {
		for (let i = this.calls.length - 1; i >= 0; i -= 1) {
			if (this.calls[i].fn === fn) {
				return this.calls[i];
			}
		}
		return undefined;
	}
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

function fakeMemento() {
	const data = new Map<string, unknown>();
	return {
		get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
		update: async (key: string, value: unknown): Promise<void> => {
			if (value === undefined) {
				data.delete(key);
			} else {
				data.set(key, value);
			}
		},
		keys: () => [...data.keys()],
	};
}

function makeHarness() {
	const views = new ViewRegistry();
	const left = new FakeView('view:left');
	const panel = new FakeView('panel:tab_1');
	views.attach({ id: left.id, kind: 'sidebar', channel: left, isVisible: () => true });
	views.attach({ id: panel.id, kind: 'panel', channel: panel, isVisible: () => false });

	const context = new HandlerContext(views, new SettingsService(memoryStore()));
	context.setViewSender((viewId, fn, ...args) => views.callJavaScriptTo(viewId, fn, ...args));

	const store = new ChatTabStore(fakeMemento() as never);
	const dispatcher = new MessageDispatcher();
	dispatcher.registerHandler(new ChatTabHandler(context, store));

	return { views, left, panel, store, dispatcher, context };
}

suite('ChatTabHandler — 多视图标签同步', () => {
	test('broadcasts the authoritative snapshot to every view', () => {
		const { left, panel, store, dispatcher } = makeHarness();

		const handled = dispatcher.dispatch('sync_tabs', JSON.stringify({
			activeTabId: 'tab_a',
			tabs: [
				{ id: 'tab_a', sessionId: 'ses_a', title: 'A' },
				{ id: 'tab_b', sessionId: null, title: '新会话' },
			],
		}));
		assert.strictEqual(handled, true);

		for (const view of [left, panel]) {
			const call = view.lastCall('apply_tabs');
			assert.ok(call, `${view.id} must receive apply_tabs`);
			const payload = JSON.parse(call.args[0]) as Record<string, unknown>;
			assert.strictEqual(payload.activeTabId, 'tab_a');
			assert.strictEqual((payload.tabs as unknown[]).length, 2);
		}

		const persisted = store.load();
		assert.ok(persisted);
		assert.strictEqual(persisted.activeTabId, 'tab_a');
		assert.strictEqual(persisted.tabs[1].sessionId, null, 'draft tabs are kept');
	});

	test('normalizes an unknown active tab to the first tab', () => {
		const { left, dispatcher } = makeHarness();

		dispatcher.dispatch('sync_tabs', JSON.stringify({
			activeTabId: 'tab_gone',
			tabs: [{ id: 'tab_a', sessionId: null, title: 'A' }],
		}));

		const payload = JSON.parse(left.lastCall('apply_tabs')!.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.activeTabId, 'tab_a');
	});

	test('drops malformed payloads without touching persisted state', () => {
		const { left, store, dispatcher } = makeHarness();

		dispatcher.dispatch('sync_tabs', 'not json');
		dispatcher.dispatch('sync_tabs', JSON.stringify({ tabs: 'nope' }));

		assert.strictEqual(left.calls.length, 0);
		assert.strictEqual(store.load(), null);
	});

	test('get_tabs answers only the requesting view', () => {
		const { left, panel, store, dispatcher, context } = makeHarness();
		store.save({
			activeTabId: 'tab_a',
			tabs: [{ id: 'tab_a', sessionId: 'ses_a', title: 'A' }],
		});

		context.setDispatchOrigin('view:left');
		const handled = dispatcher.dispatch('get_tabs', '');
		context.setDispatchOrigin(null);

		assert.strictEqual(handled, true);
		const call = left.lastCall('apply_tabs');
		assert.ok(call, 'the requesting view must get its snapshot');
		assert.strictEqual(panel.lastCall('apply_tabs'), undefined, 'other views stay untouched');
		const payload = JSON.parse(call.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.restored, true);
		assert.strictEqual(payload.activeTabId, 'tab_a');
	});

	test('tells the view there is no snapshot instead of sending an empty list', () => {
		const { left, dispatcher, context } = makeHarness();

		context.setDispatchOrigin('view:left');
		dispatcher.dispatch('get_tabs', '');
		context.setDispatchOrigin(null);

		const payload = JSON.parse(left.lastCall('apply_tabs')!.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.restored, false);
		assert.deepStrictEqual(payload.tabs, []);
	});
});
