import './mockVscode';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { createWindowCommandHandlers } from './windowDispatcherHarness';

/**
 * P9-A33：v2 提示答复必须由窗口 dispatcher 消费。
 *
 * 回归点：`permission.reply` / `question.reply` 曾经在
 * `PermissionHandler.SUPPORTED_TYPES` 里声明，却没有接进 `handle()`，
 * 于是每条答复都被 ChatWindow 落到 `UNKNOWN_TYPE`（前端直接报错，
 * 服务端 prompt 永远等不到回答）。
 */
class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];
	public raw: Array<Record<string, unknown>> = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(message: unknown): void {
		this.raw.push(message as Record<string, unknown>);
	}

	public getViewCount(): number {
		return 1;
	}
}

interface DaemonCall {
	method: string;
	params: Record<string, unknown>;
}

function makeDaemon(calls: DaemonCall[]) {
	return {
		request: (
			method: string,
			params: Record<string, unknown>,
			callback: { onLine: (line: string) => void; onError: (err: string) => void; onComplete: (ok: boolean) => void },
		) => {
			calls.push({ method, params });
			callback.onComplete(true);
			return Promise.resolve(true);
		},
	};
}

function makeChatWindow(daemon: unknown): ChatWindow {
	return new ChatWindow({
		settings: {} as never,
		daemon: daemon as never,
		fileOps: {} as never,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
	});
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
		requestId: `${type}-${Math.random().toString(36).slice(2)}`,
		tabId,
		sessionId: null,
		payload,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function eventsOf(view: MockChannel): Array<Record<string, unknown>> {
	return view.raw.flatMap((message) => (Array.isArray(message.batch) ? message.batch : []));
}

suite('P9-A33: v2 提示答复经窗口 dispatcher 落到 PermissionHandler', () => {
	setup(() => {
		Object.defineProperty(vscode.window, 'state', {
			configurable: true,
			get: () => ({ focused: true }),
		});
	});

	teardown(() => {
		delete (vscode.window as unknown as Record<string, unknown>).state;
	});

	test('question.reply 被消费并真的答复 daemon（不再 UNKNOWN_TYPE）', async () => {
		const daemonCalls: DaemonCall[] = [];
		const daemon = makeDaemon(daemonCalls);
		const chatWindow = makeChatWindow(daemon);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);
		const harness = createWindowCommandHandlers(chatWindow, daemon);
		chatWindow.setWindowCommandDispatcher(harness.dispatch);
		harness.permissionHandler.attachPromptRegistry(
			chatWindow.promptRegistry,
			(sessionId) => chatWindow.resolveTabIdForSession(sessionId),
		);

		const tabId = chatWindow.registry.getActiveTabId()!;
		harness.permissionHandler.onQuestionRequested({
			type: 'question',
			toolUseId: 'call_q',
			toolName: 'call_q',
			description: '',
			sessionId: 'ses_q',
			requestId: 'call_q',
			tabId: tabId.value,
			questions: [{ question: '继续吗？', options: ['是', '否'] }],
		});

		await sendCommand(chatWindow, 'sidebar', 'question.reply', tabId.value, {
			requestId: 'call_q',
			answers: { '继续吗？': '是' },
		});

		const rejected = eventsOf(view).filter((event) => event.type === 'command.rejected');
		assert.deepStrictEqual(rejected, [], '答复不能被当成未知命令');
		assert.ok(
			daemonCalls.some((call) => call.method === 'opencode.replyQuestion'),
			'必须把答案回给服务端',
		);

		const answered = eventsOf(view).find((event) => event.type === 'question.answered');
		assert.ok(answered, '答复成功后要发 question.answered');
		assert.strictEqual(answered?.tabId, tabId.value);
	});

	test('permission.reply 被消费并真的答复 daemon（不再 UNKNOWN_TYPE）', async () => {
		const daemonCalls: DaemonCall[] = [];
		const daemon = makeDaemon(daemonCalls);
		const chatWindow = makeChatWindow(daemon);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);
		const harness = createWindowCommandHandlers(chatWindow, daemon);
		chatWindow.setWindowCommandDispatcher(harness.dispatch);
		harness.permissionHandler.attachPromptRegistry(
			chatWindow.promptRegistry,
			(sessionId) => chatWindow.resolveTabIdForSession(sessionId),
		);

		const tabId = chatWindow.registry.getActiveTabId()!;
		harness.permissionHandler.onPermissionRequested({
			type: 'permission',
			toolUseId: 'call_p',
			toolName: 'bash',
			description: 'rm -rf build',
			sessionId: 'ses_p',
			requestId: 'per_p',
			tabId: tabId.value,
		});

		await sendCommand(chatWindow, 'sidebar', 'permission.reply', tabId.value, {
			channelId: 'call_p',
			allow: true,
			remember: false,
		});

		const rejected = eventsOf(view).filter((event) => event.type === 'command.rejected');
		assert.deepStrictEqual(rejected, [], '答复不能被当成未知命令');
		const reply = daemonCalls.find((call) => call.method === 'opencode.replyPermission');
		assert.ok(reply, '必须把决定回给服务端');
		assert.strictEqual(reply?.params.permissionID, 'per_p');
		assert.strictEqual(reply?.params.reply, 'allow');
	});
});
