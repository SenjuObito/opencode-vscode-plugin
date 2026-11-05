import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabId } from '../host/tab/TabId';
import { SessionState } from '../host/session/SessionState';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import { attachWindowCommands } from './windowDispatcherHarness';

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

/** requestId 必须逐条不同：宿主按它做幂等去重，重复的会被直接丢掉。 */
let requestSeq = 0;

async function sendCommand(
	chatWindow: ChatWindow,
	viewId: string,
	type: string,
	tabId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	requestSeq += 1;
	await chatWindow.handleViewCommand(viewId, {
		v: 2,
		type,
		requestId: `${type}-${requestSeq}`,
		tabId,
		sessionId: null,
		payload,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 可控的全局「自动打开文件」设置（按工作区路径存）。 */
function makeSettings(initial: boolean): { settings: never; state: { autoOpen: boolean } } {
	const state = { autoOpen: initial };
	const settings = {
		getPrimaryWorkspaceRoot: () => '/mock/workspace',
		getAutoOpenFileEnabled: () => state.autoOpen,
	};
	return { settings: settings as never, state };
}

function makeChatWindow(
	settings: never,
	resolvers: Array<() => boolean>,
): ChatWindow {
	const chatWindow = new ChatWindow({
		settings,
		daemon: {} as never,
		fileOps: {} as never,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
		createSession: (sink, autoOpenFileEnabledResolver) => {
			resolvers.push(autoOpenFileEnabledResolver ?? (() => false));
			const state = new SessionState();
			const adapter = new SessionCallbackAdapter({
				jsTarget: sink,
				model: () => state.getModel(),
			});
			return {
				state,
				getState: () => state,
				getAdapter: () => adapter,
				send: async () => {},
				sendShell: async () => {},
				interrupt: () => {},
				dispose: () => {},
			} as never;
		},
	});
	chatWindow.setWindowCommandDispatcher(attachWindowCommands(chatWindow, {}));
	chatWindow.registerView('sidebar', new MockChannel());
	return chatWindow;
}

suite('P8-A17: §10.12 per-tab autoOpenFileEnabled', () => {
	test('创建 tab 时快照全局值；之后全局变化只影响新建 tab', () => {
		const { settings, state } = makeSettings(false);
		const chatWindow = makeChatWindow(settings, []);

		// 引导 tab 在全局关闭时创建 → 关闭。
		const tabA = chatWindow.registry.getActiveTabId()!;
		assert.strictEqual(
			chatWindow.registry.get(tabA)!.getSettings().isAutoOpenFileEnabled(),
			false,
		);

		// 全局打开：已有 tab 不变，新 tab 继承。
		state.autoOpen = true;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();
		assert.strictEqual(
			chatWindow.registry.get(tabA)!.getSettings().isAutoOpenFileEnabled(),
			false,
			'全局变化不能回写已有 tab',
		);
		assert.strictEqual(
			chatWindow.registry.get(tabB)!.getSettings().isAutoOpenFileEnabled(),
			true,
			'新 tab 应快照当时的全局值',
		);
	});

	test('context.setEnabled 只改目标 tab，发送时解析器读该 tab 的当前值', async () => {
		const { settings } = makeSettings(false);
		const resolvers: Array<() => boolean> = [];
		const chatWindow = makeChatWindow(settings, resolvers);

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

		await sendCommand(chatWindow, 'sidebar', 'context.setEnabled', tabA.value, { enabled: true });
		assert.strictEqual(chatWindow.registry.get(tabA)!.getSettings().isAutoOpenFileEnabled(), true);
		assert.strictEqual(chatWindow.registry.get(tabB)!.getSettings().isAutoOpenFileEnabled(), false);

		// 先建会话再切换：解析器应在发送时刻读 tab，而不是建会话时的旧值。
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'a' });
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabB.value, { text: 'b' });
		assert.strictEqual(resolvers.length, 2, '两个 tab 各建了一个会话');
		assert.deepStrictEqual(resolvers.map((resolve) => resolve()), [true, false]);

		await sendCommand(chatWindow, 'sidebar', 'context.setEnabled', tabA.value, { enabled: false });
		assert.strictEqual(resolvers[0](), false, '同一解析器应读到切换后的值');
	});

	test('resync 快照携带各 tab 的开关值', async () => {
		const { settings } = makeSettings(true);
		const chatWindow = makeChatWindow(settings, []);
		const view = new MockChannel();
		chatWindow.registerView('sidebar2', view);

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar2', 'context.setEnabled', tabA.value, { enabled: false });

		const snapshots = chatWindow.registry.snapshots().map((s) => s.toJson());
		const snapshot = snapshots.find((s) => s.tabId === tabA.value);
		assert.ok(snapshot, '应有该 tab 的快照');
		assert.strictEqual(snapshot!.autoOpenFileEnabled, false);
	});

	test('tab.created 事件携带宿主快照值（前端据此校正显示）', async () => {
		const { settings } = makeSettings(true);
		const chatWindow = makeChatWindow(settings, []);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		await sendCommand(chatWindow, 'sidebar', 'tab.create', 'tab-c', {});

		const created = view.raw
			.flatMap((message) => {
				const batch = (message as { batch?: unknown[] })?.batch;
				return Array.isArray(batch) ? batch : [];
			})
			.find((event) => (event as { type?: string })?.type === 'tab.created') as
			{ payload?: { tabId?: string; autoOpenFileEnabled?: boolean } } | undefined;

		assert.ok(created, '应发布 tab.created');
		assert.strictEqual(created!.payload?.tabId, 'tab-c');
		assert.strictEqual(created!.payload?.autoOpenFileEnabled, true);
	});

	test('context.refresh 只刷新显示，不改写 tab 开关', async () => {
		const { settings } = makeSettings(true);
		const chatWindow = makeChatWindow(settings, []);
		const tabA = chatWindow.registry.getActiveTabId()!;
		const record = chatWindow.registry.get(tabA)!;

		record.getSettings().setAutoOpenFileEnabled(false);
		await sendCommand(chatWindow, 'sidebar', 'context.refresh', tabA.value, { enabled: true });

		assert.strictEqual(record.getSettings().isAutoOpenFileEnabled(), false);
	});
});
