import './mockVscode';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { PermissionHandler } from '../host/handlers/PermissionHandler';
import { PromptRegistry } from '../host/prompt/PromptRegistry';
import { ChatWindow } from '../host/window/ChatWindow';
import { TabId } from '../host/tab/TabId';
import type { HandlerContext } from '../host/router/HandlerContext';
import type { SettingsService } from '../host/settings/SettingsService';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import type { PermissionRequest } from '../host/session/types';
import type { WebviewChannel } from '../host/router/HandlerContext';

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(): void {}

	public getViewCount(): number {
		return 1;
	}
}

interface DaemonCall {
	method: string;
	params: Record<string, unknown>;
}

/** 权限/提问通知读设置与窗口焦点；关掉全部提醒，测试只关心拒绝链路。 */
function stubSettings(): SettingsService {
	return {
		getAskUserQuestionSoundNotificationEnabled: () => false,
		getAskUserQuestionNotificationEnabled: () => false,
		getSoundNotificationEnabled: () => false,
		getTaskCompletionNotificationEnabled: () => false,
		getSoundOnlyWhenUnfocused: () => false,
		getUserLanguage: () => 'en',
	} as unknown as SettingsService;
}

function makeHandler(resolveTabId: (sessionId: string | null) => string | null): {
	handler: PermissionHandler;
	registry: PromptRegistry;
	calls: Array<{ fn: string; args: string[] }>;
	daemonCalls: DaemonCall[];
} {
	const calls: Array<{ fn: string; args: string[] }> = [];
	const daemonCalls: DaemonCall[] = [];
	const context = {
		getDaemon: () => ({
			request: (
				method: string,
				params: Record<string, unknown>,
				callback: { onLine: (line: string) => void; onError: (err: string) => void; onComplete: (ok: boolean) => void },
			) => {
				daemonCalls.push({ method: method.replace(/^opencode\./, ''), params });
				callback.onComplete(true);
				return Promise.resolve(true);
			},
		}),
		callJavaScript: (fn: string, ...args: string[]) => calls.push({ fn, args }),
		getSettingsService: () => stubSettings(),
		getSession: () => null,
		resolveEffectiveWorkingDirectory: () => '/mock/workspace',
		getFallbackWorkingDirectory: () => null,
	} as unknown as HandlerContext;

	const registry = new PromptRegistry();
	const handler = new PermissionHandler(context);
	handler.attachPromptRegistry(registry, resolveTabId);
	return { handler, registry, calls, daemonCalls };
}

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
	return {
		type: 'permission',
		toolUseId: 'call_1',
		toolName: 'bash',
		description: 'rm -rf build',
		sessionId: 'ses_a',
		requestId: 'per_1',
		...overrides,
	};
}

suite('P8 §10.7: adapter 给权限请求盖上归属', () => {
	test('请求自身不带 tab/session 时由 adapter 补上', () => {
		const seen: PermissionRequest[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: () => {} },
			model: () => null,
			permissionHandler: (request) => seen.push(request),
		});
		adapter.setTabId('tab-z');
		adapter.setSessionId('ses_z');

		adapter.onPermissionRequested({
			type: 'permission',
			toolUseId: 'call_z',
			toolName: 'bash',
			description: '',
		});

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].tabId, 'tab-z');
		assert.strictEqual(seen[0].sessionId, 'ses_z');
	});

	test('task 事件也被盖上 sessionId（否则后台 tab 的子代理会混进当前面板）', () => {
		const calls: Array<{ fn: string; args: string[] }> = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: (fn: string, ...args: string[]) => calls.push({ fn, args }) },
			model: () => null,
		});
		adapter.setSessionId('ses_z');

		adapter.onTaskEvent(JSON.stringify({ subtype: 'task_notification', tool_use_id: 'call_q', status: 'completed' }));

		const event = calls.find((c) => c.fn === 'onTaskEvent');
		assert.ok(event);
		const payload = JSON.parse(event.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.sessionId, 'ses_z');
		assert.strictEqual(payload.tool_use_id, 'call_q', '原有字段不能丢');
	});

	test('请求自己带了归属时以它为准', () => {
		const seen: PermissionRequest[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: () => {} },
			model: () => null,
			permissionHandler: (request) => seen.push(request),
		});
		adapter.setTabId('tab-z');
		adapter.setSessionId('ses_z');

		adapter.onPermissionRequested({
			type: 'permission',
			toolUseId: 'call_y',
			toolName: 'bash',
			description: '',
			tabId: 'tab-y',
			sessionId: 'ses_y',
		});

		assert.strictEqual(seen[0].tabId, 'tab-y');
		assert.strictEqual(seen[0].sessionId, 'ses_y');
	});
});

suite('P8 §10.7/10.8: 未决 prompt 的 tab 归属与关 tab 拒绝', () => {
	setup(() => {
		// notifyPromptPending 会读窗口焦点。`vscode.window.state` 在真实 VS Code
		// 里是只读 getter，直接赋值会抛 "only a getter" —— 用 defineProperty
		// 覆盖底层取值。
		Object.defineProperty(vscode.window, 'state', {
			configurable: true,
			get: () => ({ focused: true }),
		});
	});

	teardown(() => {
		delete (vscode.window as unknown as Record<string, unknown>).state;
	});

	test('权限弹窗载荷带上 tabId 与 sessionId', () => {
		const { handler, calls, registry } = makeHandler(() => 'tab-a');

		handler.onPermissionRequested(permissionRequest());

		const dialog = calls.find((c) => c.fn === 'showPermissionDialog');
		assert.ok(dialog, '必须弹权限框');
		const payload = JSON.parse(dialog.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.tabId, 'tab-a');
		assert.strictEqual(payload.sessionId, 'ses_a');
		assert.strictEqual(payload.channelId, 'call_1');
		assert.strictEqual(registry.tabIdOf('call_1'), 'tab-a', '未决项必须登记到该 tab');
	});

	test('提问弹窗载荷带上 tabId，并登记到该 tab', () => {
		const { handler, calls, registry } = makeHandler(() => 'tab-a');

		handler.onQuestionRequested({
			type: 'question',
			toolUseId: 'call_2',
			toolName: 'task',
			description: '',
			sessionId: 'ses_a',
			requestId: 'q_1',
			questions: [{ question: '继续吗？', options: ['是', '否'] }],
		});

		const dialog = calls.find((c) => c.fn === 'showAskUserQuestionDialog');
		assert.ok(dialog);
		const payload = JSON.parse(dialog.args[0]) as Record<string, unknown>;
		assert.strictEqual(payload.tabId, 'tab-a');
		assert.strictEqual(registry.tabIdOf('q_1'), 'tab-a');
	});

	test('关 tab：只拒绝该 tab 的未决项，并真的 deny / rejectQuestion', () => {
		let tabOf: string | null = 'tab-a';
		const { handler, registry, calls, daemonCalls } = makeHandler(() => tabOf);

		handler.onPermissionRequested(permissionRequest());
		handler.onQuestionRequested({
			type: 'question',
			toolUseId: 'call_2',
			toolName: 'task',
			description: '',
			sessionId: 'ses_a',
			requestId: 'q_1',
			questions: [],
		});

		tabOf = 'tab-b';
		handler.onPermissionRequested(permissionRequest({
			toolUseId: 'call_3',
			requestId: 'per_3',
			sessionId: 'ses_b',
		}));

		const rejected = registry.rejectForTab('tab-a');
		assert.deepStrictEqual(rejected.sort(), ['call_1', 'q_1'], 'B 的未决项不能被 A 的关闭带走');

		handler.rejectPrompts(rejected);

		const deny = daemonCalls.find((c) => c.method === 'replyPermission');
		assert.ok(deny, '权限必须被 deny 掉，否则服务端一直等');
		assert.strictEqual(deny.params.permissionID, 'per_1');
		assert.strictEqual(deny.params.reply, 'deny');

		const rejectQuestion = daemonCalls.find((c) => c.method === 'rejectQuestion');
		assert.ok(rejectQuestion);
		assert.strictEqual(rejectQuestion.params.questionID, 'q_1');

		const closed = calls.filter((c) => c.fn === 'forceClosePermissionDialog' || c.fn === 'forceCloseAskUserQuestionDialog');
		assert.strictEqual(closed.length, 2, '两个卡片都要关掉');

		// 已处理过的不能再被重复拒绝
		assert.deepStrictEqual(registry.rejectForTab('tab-a'), []);
	});

	test('答复之后不再算未决（否则关 tab 会 deny 一个早已答过的请求）', () => {
		const { handler, registry } = makeHandler(() => 'tab-a');

		handler.onPermissionRequested(permissionRequest());
		handler.handle('permission_decision', JSON.stringify({ channelId: 'call_1', allow: true }));

		assert.strictEqual(registry.tabIdOf('call_1'), null);
		assert.deepStrictEqual(registry.rejectForTab('tab-a'), []);
	});
});

suite('v2 prompt replies stay with the tab that owns the prompt', () => {
	setup(() => {
		Object.defineProperty(vscode.window, 'state', {
			configurable: true,
			get: () => ({ focused: true }),
		});
	});

	teardown(() => {
		delete (vscode.window as unknown as Record<string, unknown>).state;
	});

	test('permission.reply from another tab is refused', () => {
		const { handler, daemonCalls } = makeHandler(() => 'tab-a');
		handler.onPermissionRequested(permissionRequest());

		handler.handleReplyCommand(
			'permission.reply',
			{ channelId: 'call_1', allow: true, remember: false, sessionId: 'ses_a' },
			'tab-b',
		);

		assert.strictEqual(daemonCalls.length, 0, 'wrong tab must not answer the prompt');
	});

	test('permission.reply from the owner tab answers it', () => {
		const { handler, daemonCalls } = makeHandler(() => 'tab-a');
		handler.onPermissionRequested(permissionRequest());

		handler.handleReplyCommand(
			'permission.reply',
			{ channelId: 'call_1', allow: true, remember: true, sessionId: 'ses_a' },
			'tab-a',
		);

		const reply = daemonCalls.find((call) => call.method === 'replyPermission');
		assert.ok(reply);
		assert.strictEqual(reply.params.permissionID, 'per_1');
		assert.strictEqual(reply.params.reply, 'allowAlways');
	});

	test('question.reply parses both answers and a rejection', () => {
		const { handler, daemonCalls } = makeHandler(() => 'tab-a');
		handler.onQuestionRequested({
			type: 'question',
			toolUseId: 'call_2',
			toolName: 'task',
			description: '',
			sessionId: 'ses_a',
			requestId: 'q_1',
			questions: [{ question: '继续吗？', options: ['是', '否'] }],
		});

		handler.handleReplyCommand(
			'question.reply',
			{ requestId: 'q_1', answers: { '继续吗？': '是' }, sessionId: 'ses_a' },
			'tab-a',
		);
		assert.ok(daemonCalls.some((call) => call.method === 'replyQuestion'));

		handler.onQuestionRequested({
			type: 'question',
			toolUseId: 'call_3',
			toolName: 'task',
			description: '',
			sessionId: 'ses_a',
			requestId: 'q_2',
			questions: [],
		});
		handler.handleReplyCommand(
			'question.reply',
			{ requestId: 'q_2', rejected: true, sessionId: 'ses_a' },
			'tab-a',
		);
		assert.ok(daemonCalls.some((call) => call.method === 'rejectQuestion'));
	});
});

suite('P8 §10.7: ChatWindow 关 tab 时上报被作废的 prompt', () => {
	test('把 rejectForTab 的结果交给宿主会话层', async () => {
		const rejectedSeen: string[][] = [];
		const chatWindow = new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			onPromptsRejected: (ids) => rejectedSeen.push(ids),
		});
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();
		chatWindow.promptRegistry.rememberPermissionTab('call_a', tabA.value);
		chatWindow.promptRegistry.rememberPermissionTab('call_b', tabB.value);

		await chatWindow.handleViewCommand('sidebar', {
			v: 2,
			type: 'tab.close',
			requestId: 'close-1',
			tabId: tabA.value,
			payload: {},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepStrictEqual(rejectedSeen, [['call_a']], '只上报被关掉那个 tab 的未决项');
		assert.strictEqual(chatWindow.promptRegistry.tabIdOf('call_b'), tabB.value, 'B 的登记还在');
	});
});
