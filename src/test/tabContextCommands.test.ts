import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import { WebviewBroadcaster } from '../host/router/WebviewBroadcaster';
import type { WebviewChannel } from '../host/router/HandlerContext';
import type { TabRecord } from '../host/tab/TabRecord';
import { TabId } from '../host/tab/TabId';

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];
	public disposed = false;

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return this.disposed;
	}

	public postRaw(): void {}

	public getViewCount(): number {
		return 1;
	}
}

function makeChatWindow(daemon: Record<string, unknown>): ChatWindow {
	return new ChatWindow({
		settings: {} as never,
		daemon: daemon as never,
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
	// 命令在 TabSessionActor 上排队执行，等微任务队列排空
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('P8-A4: tab 级 context.refresh / commands.refresh', () => {
	describe('context.refresh', () => {
		it('把开关写进目标 tab 的 TabSettings，且只影响目标 tab', async () => {
			const chatWindow = makeChatWindow({});
			const view = new MockChannel();
			chatWindow.registerView('sidebar', view);

			const tabA = chatWindow.registry.getActiveTabId()!;
			const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

			const recordA = chatWindow.registry.get(tabA) as TabRecord;
			const recordB = chatWindow.registry.get(tabB) as TabRecord;

			// 默认开启
			assert.strictEqual(recordA.getSettings().isAutoOpenFileEnabled(), false);
			assert.strictEqual(recordA.getSettings().isContextEnabled(), true);

			await sendCommand(chatWindow, 'sidebar', 'context.refresh', tabA.value, { enabled: true });
			assert.strictEqual(recordA.getSettings().isAutoOpenFileEnabled(), true);
			assert.strictEqual(recordA.getSettings().isContextEnabled(), true);

			await sendCommand(chatWindow, 'sidebar', 'context.refresh', tabA.value, { enabled: false });
			assert.strictEqual(recordA.getSettings().isAutoOpenFileEnabled(), false);
			assert.strictEqual(recordA.getSettings().isContextEnabled(), false);

			// B 未受影响
			assert.strictEqual(recordB.getSettings().isAutoOpenFileEnabled(), false);
			assert.strictEqual(recordB.getSettings().isContextEnabled(), true);
		});

		it('缺省 enabled 时按开启处理（旧版 webview 兼容）', async () => {
			const chatWindow = makeChatWindow({});
			chatWindow.registerView('sidebar', new MockChannel());
			const tabA = chatWindow.registry.getActiveTabId()!;
			const record = chatWindow.registry.get(tabA) as TabRecord;

			await sendCommand(chatWindow, 'sidebar', 'context.refresh', tabA.value, {});
			assert.strictEqual(record.getSettings().isContextEnabled(), true);
		});
	});

	describe('commands.refresh', () => {
		it('按目标 tab 的 cwd 请求命令列表并回推 updateSlashCommands', async () => {
			const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
			const daemon = {
				request(
					method: string,
					params: Record<string, unknown>,
					callback: { onLine: (line: string) => void; onError: (err: string) => void; onComplete: (ok: boolean) => void },
				) {
					requests.push({ method, params });
					callback.onLine(JSON.stringify({
						success: true,
						commands: [
							{ name: '/init', description: 'bootstrap', source: 'command' },
							{ name: 'compact', description: 'compress', source: 'command' },
							{ name: '', description: 'dropped' },
						],
					}));
					callback.onComplete(true);
					return Promise.resolve(true);
				},
			};

			const chatWindow = makeChatWindow(daemon);
			const channel = new MockChannel();
			const unregister = WebviewBroadcaster.register(channel);

			try {
				const tabId = chatWindow.registry.getActiveTabId()!;
				await sendCommand(chatWindow, 'sidebar', 'commands.refresh', tabId.value, {});

				assert.strictEqual(requests.length, 1);
				assert.strictEqual(requests[0].method, 'opencode.listCommands');
				assert.strictEqual(requests[0].params.directory, '/mock/workspace');

				const pushed = channel.calls.filter((c) => c.fn === 'updateSlashCommands');
				assert.strictEqual(pushed.length, 1);
				const commands = JSON.parse(pushed[0].args[0]) as Array<{ name: string }>;
				assert.deepStrictEqual(commands.map((c) => c.name), ['init', 'compact']);
			} finally {
				unregister();
			}
		});

		it('daemon 失败时回推空列表，不展示幽灵命令', async () => {
			const daemon = {
				request(
					_method: string,
					_params: Record<string, unknown>,
					callback: { onLine: (line: string) => void; onError: (err: string) => void; onComplete: (ok: boolean) => void },
				) {
					callback.onLine('not json at all');
					callback.onComplete(false);
					return Promise.resolve(true);
				},
			};

			const chatWindow = makeChatWindow(daemon);
			const channel = new MockChannel();
			const unregister = WebviewBroadcaster.register(channel);

			try {
				const tabId = chatWindow.registry.getActiveTabId()!;
				await sendCommand(chatWindow, 'sidebar', 'commands.refresh', tabId.value, {});

				const pushed = channel.calls.filter((c) => c.fn === 'updateSlashCommands');
				assert.strictEqual(pushed.length, 1);
				assert.deepStrictEqual(JSON.parse(pushed[0].args[0]), []);
			} finally {
				unregister();
			}
		});
	});
});
