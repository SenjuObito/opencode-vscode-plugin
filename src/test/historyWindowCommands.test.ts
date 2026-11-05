import './mockVscode';
import * as assert from 'assert';
import {
	HandlerContext,
	type TabSessionContext,
	type WebviewChannel,
} from '../host/router/HandlerContext';
import { HistoryHandler } from '../host/handlers/HistoryHandler';
import { ExportHandler } from '../host/handlers/ExportHandler';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';
import type { SettingsService } from '../host/settings/SettingsService';
import type { OpenCodeSession } from '../host/session/OpenCodeSession';

const WORKSPACE = '/mock/workspace';

interface DaemonCall {
	method: string;
	params: Record<string, unknown>;
}

interface Push {
	fn: string;
	args: string[];
}

interface PublishedEvent {
	type: string;
	tabId: string;
	payload: Record<string, unknown>;
	options?: { legacy?: boolean; sessionId?: string | null };
}

interface HarnessOptions {
	/** 让 `getSessionBySessionId` 命中一个 tab 持有的会话（quiesce 测试）。 */
	owner?: OpenCodeSession | null;
	/** `getTabIdForSession` 的返回值（history.rename 的标题事件目标）。 */
	ownerTabId?: string | null;
	/** 让这些 daemon 方法以失败回包（`onError` + `onComplete(false)`）。 */
	failMethods?: string[];
}

function makeHarness(options: HarnessOptions = {}) {
	const calls: DaemonCall[] = [];
	const pushes: Push[] = [];
	const events: PublishedEvent[] = [];
	const store = {
		getGlobal: () => undefined,
		setGlobal: () => {},
	};

	const channel: WebviewChannel = {
		callJavaScript: (fn, ...args) => pushes.push({ fn, args }),
		isDisposed: () => false,
		postRaw: () => {},
		getViewCount: () => 1,
	};

	const daemon = {
		request: (method: string, params: Record<string, unknown>, callback: {
			onLine?: (line: string) => void;
			onError?: (error: string) => void;
			onComplete?: (success: boolean) => void;
		}) => {
			calls.push({ method, params });
			if (method === 'opencode.listSessions') {
				callback.onLine?.(JSON.stringify({
					success: true,
					sessions: [{ id: 'ses_x', title: 'Session X', time: { updated: 1_700_000_000_000 } }],
				}));
			}
			const success = !(options.failMethods ?? []).includes(method);
			if (!success) {
				callback.onError?.(`${method} failed`);
			}
			callback.onComplete?.(success);
			return Promise.resolve(success);
		},
	} as unknown as OpenCodeDaemonBridge;

	const settings = {
		getEffectiveWorkingDirectory: () => WORKSPACE,
		getStore: () => store,
	} as unknown as SettingsService;

	const context = new HandlerContext(channel, settings);
	context.setDaemon(daemon);
	const tabSessionContext: TabSessionContext = {
		getSessionForTab: () => null,
		createSessionForTab: () => null,
		getSessionBySessionId: (sessionId) => (
			options.owner && sessionId === 'ses_x' ? options.owner : null
		),
		getTabIdForSession: (sessionId) => (
			sessionId === 'ses_x' ? (options.ownerTabId ?? null) : null
		),
		getCwdForTab: () => WORKSPACE,
		getSendSettings: () => null,
		resolveAttachment: () => null,
		setTabAutoOpenFileEnabled: () => {},
		pauseQueue: () => {},
		markHistoryLoaded: () => {},
	};
	context.setTabSessionContext(tabSessionContext);
	context.setEventPublisher((type, tabId, payload, options) => {
		events.push({ type, tabId: tabId ?? '', payload, options });
	});

	return {
		history: new HistoryHandler(context),
		exporter: new ExportHandler(context),
		calls,
		pushes,
		events,
	};
}

/** 让 `Promise.all(...).then` 之类的微任务落地。 */
function flushAsync(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

suite('History window commands speak the v2 contract', () => {
	test('history.delete deletes the session named by the payload, not the payload itself', async () => {
		const h = makeHarness();

		const handled = h.history.handle('history.delete', JSON.stringify({ sessionId: 'ses_x' }));

		assert.strictEqual(handled, true);
		const deletes = h.calls.filter((call) => call.method === 'opencode.deleteSession');
		assert.strictEqual(deletes.length, 1);
		assert.strictEqual(deletes[0].params.sessionId, 'ses_x');
		assert.strictEqual(deletes[0].params.directory, WORKSPACE);

		await flushAsync();
		// 删除成功后宿主重拉列表，webview 的乐观删除由权威数据接管。
		assert.ok(h.calls.some((call) => call.method === 'opencode.listSessions'));
		assert.ok(h.pushes.some((push) => push.fn === 'setHistoryData'));
	});

	test('history.delete rejects a path-traversal session id', () => {
		const h = makeHarness();

		assert.strictEqual(h.history.handle('history.delete', JSON.stringify({ sessionId: '../../etc/passwd' })), true);

		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.deleteSession').length, 0);
	});

	test('history.delete interrupts the tab-owned session before deleting it', () => {
		let interrupted = false;
		const owner = {
			state: { isBusy: () => true },
			interrupt: () => { interrupted = true; },
		} as unknown as OpenCodeSession;
		const h = makeHarness({ owner });

		h.history.handle('history.delete', JSON.stringify({ sessionId: 'ses_x' }));

		assert.strictEqual(interrupted, true);
	});

	test('history.deleteMany deletes every named session and reloads once', async () => {
		const h = makeHarness();

		h.history.handle('history.deleteMany', JSON.stringify({ sessionIds: ['ses_x', 'ses_y', 'ses_x'] }));

		const deletes = h.calls.filter((call) => call.method === 'opencode.deleteSession');
		assert.deepStrictEqual(
			deletes.map((call) => call.params.sessionId).sort(),
			['ses_x', 'ses_y'],
		);

		await flushAsync();
		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.favorite toggles the session named by the payload', () => {
		const h = makeHarness();

		assert.strictEqual(h.history.handle('history.favorite', JSON.stringify({ sessionId: 'ses_x' })), true);

		const toggles = h.calls.filter((call) => call.method === 'opencode.toggleFavorite');
		assert.strictEqual(toggles.length, 1);
		assert.strictEqual(toggles[0].params.sessionId, 'ses_x');
	});

	test('history.deepSearch is a reload, not an unsupported command', () => {
		const h = makeHarness();

		assert.strictEqual(h.history.handle('history.deepSearch', JSON.stringify({})), true);

		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.refresh reloads the list', () => {
		const h = makeHarness();

		assert.strictEqual(h.history.handle('history.refresh', JSON.stringify({ provider: 'opencode' })), true);

		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.rename writes the server title and re-addresses the title event to the owning tab', () => {
		const h = makeHarness({ ownerTabId: 'tab-1' });

		assert.strictEqual(
			h.history.handle('history.rename', JSON.stringify({ sessionId: 'ses_x', title: 'Renamed' })),
			true,
		);

		const updates = h.calls.filter((call) => call.method === 'opencode.updateSessionTitle');
		assert.strictEqual(updates.length, 1);
		assert.strictEqual(updates[0].params.sessionId, 'ses_x');
		assert.strictEqual(updates[0].params.title, 'Renamed');

		const titleEvents = h.events.filter((event) => event.type === 'tab.title.changed');
		assert.strictEqual(titleEvents.length, 1);
		assert.strictEqual(titleEvents[0].tabId, 'tab-1');
		assert.strictEqual(titleEvents[0].payload.title, 'Renamed');
		// 事件就是 webview 的 `updateSessionTitle`，不要再按位置调一次 window.<fn>。
		assert.strictEqual(titleEvents[0].options?.legacy, false);
		assert.strictEqual(titleEvents[0].options?.sessionId, 'ses_x');
	});

	test('history.rename to a session that is not open in a tab still reaches the webview', () => {
		const h = makeHarness({ ownerTabId: null });

		h.history.handle('history.rename', JSON.stringify({ sessionId: 'ses_x', title: 'Renamed' }));

		const titleEvents = h.events.filter((event) => event.type === 'tab.title.changed');
		assert.strictEqual(titleEvents.length, 1);
		// 空 tabId = 全局 lane，所有视图都能更新那一行历史标题。
		assert.strictEqual(titleEvents[0].tabId, '');
		assert.strictEqual(titleEvents[0].payload.title, 'Renamed');
	});

	test('history.delete failure still reloads, so the optimistic removal is undone', async () => {
		const h = makeHarness({ failMethods: ['opencode.deleteSession'] });

		h.history.handle('history.delete', JSON.stringify({ sessionId: 'ses_x' }));

		await flushAsync();
		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.deleteSession').length, 1);
		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.favorite failure still reloads, so the optimistic toggle is undone', async () => {
		const h = makeHarness({ failMethods: ['opencode.toggleFavorite'] });

		h.history.handle('history.favorite', JSON.stringify({ sessionId: 'ses_x' }));

		await flushAsync();
		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.rename failure keeps the old title and does not publish a title event', async () => {
		const h = makeHarness({ ownerTabId: 'tab-1', failMethods: ['opencode.updateSessionTitle'] });

		h.history.handle('history.rename', JSON.stringify({ sessionId: 'ses_x', title: 'Renamed' }));

		await flushAsync();
		assert.strictEqual(h.events.filter((event) => event.type === 'tab.title.changed').length, 0);
		// 重拉列表把 webview 的乐观改名撤回。
		assert.strictEqual(h.calls.filter((call) => call.method === 'opencode.listSessions').length, 1);
	});

	test('history.export is owned by the export handler and reads the whole transcript', async () => {
		const h = makeHarness();

		// mode=copy 走剪贴板，测试里不会弹保存对话框。
		assert.strictEqual(
			h.exporter.handle('history.export', JSON.stringify({ sessionId: 'ses_x', title: 'Session X', mode: 'copy' })),
			true,
		);

		await flushAsync();
		const list = h.calls.filter((call) => call.method === 'opencode.listMessages');
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0].params.sessionId, 'ses_x');
		assert.strictEqual(list[0].params.all, true);
	});

	test('the legacy snake_case names are gone: one command name per operation', () => {
		const h = makeHarness();

		for (const legacy of [
			'load_history_data',
			'load_session',
			'delete_session',
			'delete_sessions',
			'toggle_favorite',
			'update_title',
		]) {
			assert.strictEqual(h.history.handle(legacy, '{}'), false, `${legacy} must not be handled`);
			assert.strictEqual(h.history.getSupportedTypes().includes(legacy), false, `${legacy} must not be advertised`);
		}
		assert.strictEqual(h.exporter.handle('export_session', '{}'), false);
		assert.strictEqual(h.exporter.handle('export_session_markdown', '{}'), false);
	});
});
