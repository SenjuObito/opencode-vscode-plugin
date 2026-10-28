import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabId } from '../host/tab/TabId';
import type { FileEntry } from '../host/handlers/FileHandler';

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

/** 从视图收到的 host.events 批次里取出某个语义事件。 */
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
		requestId: `${type}-1`,
		tabId,
		sessionId: null,
		payload,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const entry = (name: string): FileEntry => ({
	name,
	path: `src/${name}`,
	absolutePath: `/mock/src/${name}`,
	type: 'file',
});

suite('P8-A15: §10.11 files.list —— @ 候选按 tab 列举并事件化', () => {
	test('按目标 tab 的 cwd 列举，结果作为 files.listed 事件回到那个 tab', async () => {
		const calls: Array<{ query: string; directory: string | undefined }> = [];
		const chatWindow = new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			listFiles: async (query: string, directory: string | undefined) => {
				calls.push({ query, directory });
				return [entry('a.ts')];
			},
		});
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/other-cwd').getTabId();

		await sendCommand(chatWindow, 'sidebar', 'files.list', tabB.value, {
			query: 'a',
			requestId: 42,
		});

		// 目录必须来自**目标 tab**，不是窗口级设置目录。
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].query, 'a');
		assert.strictEqual(calls[0].directory, '/mock/other-cwd');

		const events = collectEvents(view, 'files.listed');
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].tabId, tabB.value);
		assert.strictEqual(events[0].fn, 'onFileListResult');

		const payload = JSON.parse(String((events[0].payload as { data: string }).data)) as {
			files: Array<{ name: string }>;
			requestId: number;
		};
		assert.strictEqual(payload.requestId, 42, 'requestId 必须原样带回（乱序返回靠它对齐）');
		assert.deepStrictEqual(payload.files.map((f) => f.name), ['a.ts']);
		assert.notStrictEqual(events[0].tabId, tabA.value);
	});

	test('列举失败时回空列表（前端不能挂到超时）', async () => {
		const chatWindow = new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			listFiles: async () => {
				throw new Error('boom');
			},
		});
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar', 'files.list', tabA.value, { query: 'x' });

		const events = collectEvents(view, 'files.listed');
		assert.strictEqual(events.length, 1);
		const payload = JSON.parse(String((events[0].payload as { data: string }).data)) as {
			files: unknown[];
		};
		assert.deepStrictEqual(payload.files, []);
	});
});
