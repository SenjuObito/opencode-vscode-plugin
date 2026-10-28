import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import { parseSlashCommand } from '../host/session/OpenCodeSession';
import {
	clearAdvertisedCommands,
	rememberAdvertisedCommands,
} from '../host/util/SlashCommandCatalog';
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

function collectEvents(view: MockChannel, type: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const message of view.raw) {
		const batch = (message as { batch?: unknown[] })?.batch;
		if (!Array.isArray(batch)) {
			continue;
		}
		for (const entry of batch) {
			if ((entry as { type?: string })?.type === type) {
				events.push(entry as Record<string, unknown>);
			}
		}
	}
	return events;
}

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

describe('P8-A18: §10.14 斜杠命令 —— 列表按 tab、未知命令回退普通消息', () => {
	describe('命令识别', () => {
		it('内置命令按命令处理', () => {
			assert.deepStrictEqual(parseSlashCommand('/review'), { command: 'review', arguments: '' });
			assert.deepStrictEqual(parseSlashCommand('/compact x'), { command: 'compact', arguments: 'x' });
			assert.deepStrictEqual(parseSlashCommand('/plan'), { command: 'plan', arguments: '' });
		});

		it('服务端公布过的自定义命令也算命令', () => {
			rememberAdvertisedCommands([{ name: 'deploy' }]);
			assert.deepStrictEqual(parseSlashCommand('/deploy prod'), { command: 'deploy', arguments: 'prod' });
			clearAdvertisedCommands();
			assert.strictEqual(parseSlashCommand('/deploy prod'), null);
		});

		it('未知的斜杠文本按普通消息处理（不吞掉编辑器上下文）', () => {
			clearAdvertisedCommands();
			assert.strictEqual(parseSlashCommand('/not_a_command'), null);
			assert.strictEqual(parseSlashCommand('/Users/dev/main.go'), null);
			assert.strictEqual(parseSlashCommand('/v2/chat/completions'), null);
		});
	});

	describe('列表按 tab', () => {
		it('commands.refresh 的结果投回目标 tab，不广播', async () => {
			const daemon = {
				request(
					_method: string,
					params: Record<string, unknown>,
					callback: { onLine: (line: string) => void; onComplete: (ok: boolean) => void },
				) {
					callback.onLine(JSON.stringify({
						success: true,
						commands: [{ name: '/deploy', description: 'ship it' }],
					}));
					callback.onComplete(true);
					return Promise.resolve(true);
				},
			};

			const chatWindow = new ChatWindow({
				settings: {} as never,
				daemon: daemon as never,
				fileOps: {} as never,
				fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			});
			const view = new MockChannel();
			chatWindow.registerView('sidebar', view);

			const tabA = chatWindow.registry.getActiveTabId()!;
			const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/other').getTabId();

			await sendCommand(chatWindow, 'sidebar', 'commands.refresh', tabB.value, {});

			const events = collectEvents(view, 'slash.commands');
			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0].tabId, tabB.value, '必须投回请求方 tab');
			assert.notStrictEqual(events[0].tabId, tabA.value);

			const payload = events[0].payload as { commands: Array<{ name: string }> };
			// 宿主剥掉前导 '/'（与 command.list 的形状一致）。
			assert.deepStrictEqual(payload.commands.map((c) => c.name), ['deploy']);

			// 路由器会同时投递 legacy 回调（它是「某个 tab 的事件」的副本）；
			// webview 侧看到这种对象形态就忽略，归属只认 v2 的 envelope.tabId。
			const legacy = view.calls.filter((c) => c.fn === 'updateSlashCommands');
			assert.strictEqual(legacy.length, 1);
			assert.ok(
				Array.isArray((JSON.parse(legacy[0].args[0]) as { commands?: unknown }).commands),
				'legacy 副本应是包装形态（webview 据此忽略它）',
			);
		});
	});
});
