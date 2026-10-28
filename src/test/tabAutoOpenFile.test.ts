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

/**
 * §10.12：「自动打开文件」开关按 tab 生效。
 *
 * 之前会话层只读全局项目设置（`getAutoOpenFileEnabled(projectPath)`），tab 自己的
 * 开关（context.refresh 写进 TabSettings）形同虚设。现在会话按 tab 解析：tab 显式
 * 设过就用它的，没设过才跟随全局。
 */
suite('P8-A17: §10.12 per-tab autoOpenFileEnabled', () => {
	test('没设过的 tab 跟随全局（undefined），设过的 tab 用自己的值', async () => {
		const resolvers = new Map<string, () => boolean | null | undefined>();
		const chatWindow = new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			createSession: (sink, autoOpenFileEnabledResolver) => {
				const tabId = resolvers.size === 0 ? 'tab-a' : 'tab-b';
				resolvers.set(tabId, autoOpenFileEnabledResolver ?? (() => undefined));
				return {
					state: { setCwd: () => {}, setPermissionMode: () => {}, setReasoningEffort: () => {}, getCwd: () => '/mock/workspace' },
					getState: () => ({}),
					getAdapter: () => ({ setTabId: () => {}, setSessionId: () => {}, getCoalescer: () => null }),
					send: async () => {},
					sendShell: async () => {},
					interrupt: () => {},
					dispose: () => {},
				} as never;
			},
		});
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

		// A 显式关掉「自动打开文件」，B 不动（跟随全局）。
		await sendCommand(chatWindow, 'sidebar', 'context.refresh', tabA.value, { enabled: false });
		assert.strictEqual(
			chatWindow.registry.get(tabA)!.getSettings().getAutoOpenFileOverride(),
			false,
			'A 应记录自己的取值',
		);
		assert.strictEqual(
			chatWindow.registry.get(tabB)!.getSettings().getAutoOpenFileOverride(),
			undefined,
			'B 没设过，应为 undefined（跟随全局）',
		);

		// 建会话：每个 tab 的会话拿到自己的 resolver。
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'a' });
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabB.value, { text: 'b' });

		assert.strictEqual(resolvers.size, 2, '两个 tab 各建了一个会话');
		const values = [...resolvers.values()].map((resolve) => resolve());
		assert.ok(
			values.includes(false),
			`应有一个 tab 解析到 false（自己的设置），实际：${JSON.stringify(values)}`,
		);
		assert.ok(
			values.includes(undefined),
			`应有一个 tab 解析到 undefined（跟随全局），实际：${JSON.stringify(values)}`,
		);
	});
});
