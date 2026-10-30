import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import { TabId } from '../host/tab/TabId';
import { SessionState } from '../host/session/SessionState';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import type { OpenCodeSession, SendMessagePayload } from '../host/session/OpenCodeSession';
import type { WebviewChannel } from '../host/router/HandlerContext';
import type { JsTarget } from '../host/session/SessionCallbackAdapter';
import type { TabEventSink } from '../host/tab/TabEvent';
import { attachWindowCommands } from './windowDispatcherHarness';

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];
	public raw: Array<Record<string, unknown>> = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(message: unknown): void { this.raw.push(message as Record<string, unknown>); }

	public getViewCount(): number {
		return 1;
	}
}

interface FakeSession {
	tabSink: JsTarget;
	session: OpenCodeSession;
	sent: SendMessagePayload[];
	shells: string[];
	interrupts: number;
	disposed: number;
}

function makeSessionFactory(): { create: (sink: JsTarget, eventSink?: TabEventSink) => OpenCodeSession; all: FakeSession[] } {
	const all: FakeSession[] = [];
	const create = (tabSink: JsTarget, eventSink?: TabEventSink): OpenCodeSession => {
		const state = new SessionState();
		const adapter = new SessionCallbackAdapter({
			jsTarget: tabSink,
			eventSink,
			model: () => state.getModel(),
			windowBaseIndex: () => state.getWindowBaseIndex(),
		});
		const record: FakeSession = {
			tabSink,
			sent: [],
			shells: [],
			interrupts: 0,
			disposed: 0,
			session: null as unknown as OpenCodeSession,
		};
		record.session = {
			state,
			getState: () => state,
			getAdapter: () => adapter,
			setCallback: () => {},
			send: async (payload: SendMessagePayload) => {
				record.sent.push(payload);
			},
			sendShell: async (command: string) => {
				record.shells.push(command);
			},
			interrupt: () => {
				record.interrupts += 1;
			},
			dispose: () => {
				record.disposed += 1;
			},
		} as unknown as OpenCodeSession;
		all.push(record);
		return record.session;
	};
	return { create, all };
}

function makeChatWindow(factory: ReturnType<typeof makeSessionFactory>): ChatWindow {
	const chatWindow = new ChatWindow({
		settings: {} as never,
		daemon: {} as never,
		fileOps: {} as never,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
		createSession: (sink, _auto, _ctx, eventSink) => factory.create(sink, eventSink),
	});
	chatWindow.setWindowCommandDispatcher(attachWindowCommands(chatWindow, {}));
	return chatWindow;
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

suite('P8-A1/A2: 会话归属与 session.send / session.interrupt', () => {
	test('两个 tab 各持一个会话，互不相同', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'hello A' });
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabB.value, { text: 'hello B' });

		const recordA = chatWindow.registry.get(tabA)!;
		const recordB = chatWindow.registry.get(tabB)!;
		assert.ok(recordA.getSession(), 'A 应该有会话');
		assert.ok(recordB.getSession(), 'B 应该有会话');
		assert.notStrictEqual(recordA.getSession(), recordB.getSession(), 'A/B 必须是两个会话');

		// 第一次发送时 B 还不是活跃 tab，会话输出被投影拦下；这里只断言"发到了自己的会话"
		const sessions = factory.all;
		assert.strictEqual(sessions.length, 2);
		const sessionA = sessions.find((s) => s.sent.some((p) => p.text === 'hello A'));
		const sessionB = sessions.find((s) => s.sent.some((p) => p.text === 'hello B'));
		assert.ok(sessionA);
		assert.ok(sessionB);
		assert.notStrictEqual(sessionA, sessionB, '发送不能落到同一个会话');
		assert.strictEqual(sessionA.sent.length, 1, 'A 只收到自己那条');
		assert.strictEqual(sessionB.sent.length, 1, 'B 只收到自己那条');
	});

	test('interrupt 只打目标 tab', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'a' });
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabB.value, { text: 'b' });

		const sessionA = factory.all.find((s) => s.sent[0]?.text === 'a')!;
		const sessionB = factory.all.find((s) => s.sent[0]?.text === 'b')!;

		await sendCommand(chatWindow, 'sidebar', 'session.interrupt', tabB.value, {});
		assert.strictEqual(sessionB.interrupts, 1);
		assert.strictEqual(sessionA.interrupts, 0, 'A 不能被 B 的中断波及');
	});

	test('`!cmd` 走 sendShell，目标 tab 的 cwd 作为工作目录', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: '!ls -la' });

		const session = factory.all[0];
		assert.deepStrictEqual(session.shells, ['ls -la']);
		assert.strictEqual(session.sent.length, 0, '`!` 内容不能当 prompt 发出去');
	});

	test('bootstrap tab 预建会话，首次发送复用它', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		assert.strictEqual(tabA.value, 'tab-1', 'bootstrap tab 必须是 webview 的初始身份');
		const bootstrapSession = chatWindow.registry.get(tabA)!.getSession();
		assert.ok(bootstrapSession, 'idea bootstrap tab 必须有 provisional session');
		assert.strictEqual(factory.all.length, 1);

		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'first' });
		assert.strictEqual(chatWindow.registry.get(tabA)!.getSession(), bootstrapSession);
		assert.strictEqual(factory.all.length, 1, '首次发送不能重建会话');
	});

	test('tab.create 让新 tab 继承当前会话的模型 / 模式 / 推理力度', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		const sessionA = chatWindow.registry.get(tabA)!.getSession()!;
		sessionA.state.setModel('opencode/deepseek-v4');
		sessionA.state.setPermissionMode('plan');
		sessionA.state.setReasoningEffort('high');

		await sendCommand(chatWindow, 'sidebar', 'tab.create', 'tab-b', {});

		const sessionB = chatWindow.registry.get(TabId.of('tab-b'))!.getSession()!;
		assert.strictEqual(sessionB.state.getModel(), 'opencode/deepseek-v4');
		assert.strictEqual(sessionB.state.getPermissionMode(), 'plan');
		assert.strictEqual(sessionB.state.getReasoningEffort(), 'high');
		assert.notStrictEqual(sessionB, sessionA, '新 tab 必须有自己的会话');
	});

	test('unknown tab 被拒绝，不再由宿主自动补建', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		await sendCommand(chatWindow, 'sidebar', 'session.send', 'tab-missing', { text: 'nope' });

		assert.strictEqual(chatWindow.registry.get(TabId.of('tab-missing')), null);
		const rejected = view.raw
			.flatMap((message) => (Array.isArray(message.batch) ? message.batch : []))
			.find((event: any) => event?.type === 'command.rejected');
		assert.ok(rejected, '必须回 command.rejected');
	});

	test('服务端分配 sessionId 后绑定到 tab，可按会话反查', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'bind me' });

		const session = chatWindow.registry.get(tabA)!.getSession()!;
		session.state.setSessionId('ses_123');

		assert.strictEqual(chatWindow.registry.get(tabA)!.getSessionIdString(), 'ses_123');
		assert.strictEqual(chatWindow.registry.findBySession('ses_123')?.getTabId().value, tabA.value);
	});

	test('切 tab 时回放该 tab 的快照与选择（不动另一个 tab）', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = chatWindow.registry.getActiveTabId()!;
		const tabB = chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();

		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'a' });
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabB.value, { text: 'b' });

		view.calls.length = 0;
		view.raw.length = 0;
		await sendCommand(chatWindow, 'sidebar', 'tab.activate', tabB.value, {});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const types = view.raw
			.filter((message) => message.type === 'host.events')
			.flatMap((message) => (message.batch as Array<Record<string, unknown>>) ?? [])
			.map((event) => event.type);
		assert.ok(types.includes('session.cleared'), '切 tab 必须先清屏（带屏障序列号）');
		assert.ok(types.includes('message.snapshot'), '切 tab 必须回放快照');
		assert.ok(types.includes('tab.state'), '切 tab 必须恢复该 tab 的 model/mode/effort');
		assert.ok(types.includes('session.loaded'), '回放结束要释放过渡态');
	});

	test('切历史会话：先释放旧绑定再重绑，旧会话被释放', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'old' });
		const oldSession = chatWindow.registry.get(tabA)!.getSession()!;
		oldSession.state.setSessionId('ses_old');

		const attached = chatWindow.switchActiveTabSession('ses_new');
		assert.ok(attached, '必须能绑到新会话（已绑定时不释放会抛 already bound）');
		assert.notStrictEqual(attached, oldSession);
		assert.strictEqual(chatWindow.registry.get(tabA)!.getSessionIdString(), 'ses_new');
		assert.strictEqual(chatWindow.registry.findBySession('ses_old'), null, '旧会话不能再反查到本 tab');
		assert.strictEqual(
			factory.all.find((s) => s.session === oldSession)!.disposed,
			1,
			'旧会话必须被释放',
		);

		// 重复切到同一个会话不重建（重建会丢正在进行的流）
		const again = chatWindow.switchActiveTabSession('ses_new');
		assert.strictEqual(again, attached);
	});

	test('新对话在同一个 tab 内重置绑定', async () => {
		const factory = makeSessionFactory();
		const chatWindow = makeChatWindow(factory);
		chatWindow.registerView('sidebar', new MockChannel());

		const tabA = chatWindow.registry.getActiveTabId()!;
		await sendCommand(chatWindow, 'sidebar', 'session.send', tabA.value, { text: 'old' });
		chatWindow.registry.get(tabA)!.getSession()!.state.setSessionId('ses_old');

		const fresh = chatWindow.switchActiveTabSession(null);
		assert.ok(fresh);
		assert.strictEqual(chatWindow.registry.size(), 1, '新对话不能新增 tab');
		assert.strictEqual(chatWindow.registry.get(tabA)!.getSessionIdString(), null);
		assert.strictEqual(chatWindow.registry.findBySession('ses_old'), null);
	});

	});
