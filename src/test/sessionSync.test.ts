import * as assert from 'assert';

import { HandlerContext, type WebviewChannel } from '../host/router/HandlerContext';
import { SettingsService, type SettingsStore } from '../host/settings/SettingsService';
import { OpenCodeSession } from '../host/session/OpenCodeSession';
import { createMessage } from '../host/session/SessionState';
import { MessageType } from '../host/session/types';
import { resyncSessionFromServerIfNeeded } from '../host/session/SessionResync';
import { ChatTabStore } from '../host/tabs/ChatTabStore';
import { buildNotificationPreview, buildNotificationTitle } from '../host/notifications/NotificationService';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';

/**
 * 多会话同步（水化 / 对账 / 重同步 / tab 持久化 / 通知摘要）。
 *
 * 这组用例对应 idea `SessionMessageOrchestrator.loadFromServer|reconcileWithServer`
 * 与 `OpencodeBuddyChatWindow.resyncSessionFromServerIfNeeded` 的移植，重点看守
 * 「幽灵会话」：sessionId 还绑着、消息却是空的，用户下一条消息会被追加到旧对话。
 */

interface RecordedCall {
	fn: string;
	args: string[];
}

class FakeChannel implements WebviewChannel {
	readonly calls: RecordedCall[] = [];
	callJavaScript(fn: string, ...args: string[]): void {
		this.calls.push({ fn, args });
	}
	postRaw(): void {}
	isDisposed(): boolean {
		return false;
	}
	lastCall(fn: string): RecordedCall | undefined {
		for (let i = this.calls.length - 1; i >= 0; i -= 1) {
			if (this.calls[i].fn === fn) {
				return this.calls[i];
			}
		}
		return undefined;
	}
	count(fn: string): number {
		return this.calls.filter((call) => call.fn === fn).length;
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

interface FakeResponse {
	success: boolean;
	entries?: Array<{ info: Record<string, unknown>; parts: unknown[] }>;
	error?: string;
}

/** 只实现 OpenCodeSession 用到的 daemon 面。 */
class FakeDaemon {
	readonly calls: string[] = [];
	readonly responses: FakeResponse[] = [];

	async request(method: string, _params: Record<string, unknown>, callback: {
		onLine?: (line: string) => void;
		onError?: (error: string) => void;
		onComplete?: (success: boolean) => void;
	}): Promise<boolean> {
		this.calls.push(method);
		const response = this.responses.shift() ?? { success: true, entries: [] };
		if (!response.success) {
			callback.onError?.(response.error ?? 'failed');
			callback.onComplete?.(false);
			return true;
		}
		for (const entry of response.entries ?? []) {
			callback.onLine?.(JSON.stringify({ messageEntry: entry }));
		}
		callback.onLine?.(JSON.stringify({ messagesDone: true }));
		callback.onComplete?.(true);
		return true;
	}

	registerSessionSink(): void {}
	unregisterSessionSink(): void {}
	sendAbort(): void {}
}

function sdkEntry(id: string, role: 'user' | 'assistant', text: string) {
	return {
		info: { id, role, time: { created: 1700000000000 } },
		parts: [{ type: 'text', text }],
	};
}

function makeSession(sessionId: string | null) {
	const channel = new FakeChannel();
	const daemon = new FakeDaemon();
	const context = new HandlerContext(channel, new SettingsService(memoryStore()));
	const session = new OpenCodeSession({
		context,
		daemon: daemon as unknown as OpenCodeDaemonBridge,
		initialSessionId: sessionId,
	});
	context.setSession(session);
	return { session, channel, daemon, context };
}

suite('OpenCodeSession.hydrateSessionToWebview', () => {
	test('sends one single-argument packet with messages, streaming flag and revert boundary', () => {
		const { session, channel } = makeSession('ses_1');
		session.state.addMessage(createMessage(MessageType.USER, 'hello', { id: 'msg_1' }));
		session.state.setRevertState({ messageID: 'msg_1' });

		session.hydrateSessionToWebview();

		const call = channel.lastCall('onSessionHydrated');
		assert.ok(call, 'onSessionHydrated should be called');
		assert.strictEqual(call.args.length, 1, 'packet must be a single JSON argument');
		const packet = JSON.parse(call.args[0]) as Record<string, unknown>;
		assert.strictEqual(packet.sessionId, 'ses_1');
		assert.strictEqual(packet.isStreaming, false);
		assert.strictEqual(packet.loading, false);
		assert.strictEqual(packet.revertBoundaryId, 'msg_1');
		assert.strictEqual((packet.messages as unknown[]).length, 1);
	});

	test('skips the push when no session is bound', () => {
		const { session, channel } = makeSession(null);
		session.hydrateSessionToWebview();
		assert.strictEqual(channel.count('onSessionHydrated'), 0);
	});
});

suite('OpenCodeSession.reconcileWithServer', () => {
	test('does not touch state while the session is busy', async () => {
		const { session, daemon } = makeSession('ses_1');
		session.state.setBusy(true);

		const updated = await session.reconcileWithServer();

		assert.strictEqual(updated, false);
		assert.deepStrictEqual(daemon.calls, [], 'no listMessages while streaming');
	});

	test('keeps local messages when the server returns an empty transcript', async () => {
		const { session, daemon } = makeSession('ses_1');
		session.state.addMessage(createMessage(MessageType.USER, 'local', { id: 'msg_local' }));
		daemon.responses.push({ success: true, entries: [] });

		const updated = await session.reconcileWithServer();

		assert.strictEqual(updated, false);
		assert.strictEqual(session.state.getMessages().length, 1, 'local transcript must survive');
	});

	test('replaces the snapshot when the server has more messages', async () => {
		const { session, daemon } = makeSession('ses_1');
		session.state.addMessage(createMessage(MessageType.USER, 'first', { id: 'msg_1' }));
		daemon.responses.push({
			success: true,
			entries: [sdkEntry('msg_1', 'user', 'first'), sdkEntry('msg_2', 'assistant', 'second')],
		});

		const updated = await session.reconcileWithServer();

		assert.strictEqual(updated, true);
		// 推送走 StreamMessageCoalescer（合并 + 节流），因此这里断言状态本身，
		// 而不是通道上的即时调用。
		assert.strictEqual(session.state.getMessages().length, 2);
		assert.strictEqual(session.state.getMessages()[1].content, 'second');
	});

	test('leaves identical transcripts alone', async () => {
		const { session, daemon } = makeSession('ses_1');
		daemon.responses.push({ success: true, entries: [sdkEntry('msg_1', 'user', 'only')] });
		await session.loadFromServer();

		daemon.responses.push({ success: true, entries: [sdkEntry('msg_1', 'user', 'only')] });
		const updated = await session.reconcileWithServer();

		assert.strictEqual(updated, false);
	});
});

suite('resyncSessionFromServerIfNeeded', () => {
	const noSleep = async (): Promise<void> => {};

	test('skips when the frontend is not ready', async () => {
		const { session, daemon } = makeSession('ses_1');
		const outcome = await resyncSessionFromServerIfNeeded(session, { frontendReady: false, sleep: noSleep });
		assert.strictEqual(outcome, 'skipped');
		assert.deepStrictEqual(daemon.calls, []);
	});

	test('skips when the view already holds messages', async () => {
		const { session, daemon } = makeSession('ses_1');
		session.state.addMessage(createMessage(MessageType.USER, 'cached', { id: 'msg_1' }));

		const outcome = await resyncSessionFromServerIfNeeded(session, { frontendReady: true, sleep: noSleep });

		assert.strictEqual(outcome, 'skipped');
		assert.deepStrictEqual(daemon.calls, [], 'never reload over existing content');
	});

	test('loads from the server and reports the authoritative count', async () => {
		const { session, daemon, channel } = makeSession('ses_1');
		daemon.responses.push({ success: true, entries: [sdkEntry('msg_1', 'user', 'restored')] });

		const outcome = await resyncSessionFromServerIfNeeded(session, { frontendReady: true, sleep: noSleep });

		assert.strictEqual(outcome, 'loaded');
		assert.strictEqual(session.state.getMessages().length, 1);
		const complete = channel.lastCall('historyLoadComplete');
		assert.deepStrictEqual(complete?.args, ['ses_1', '1']);
		assert.ok(channel.lastCall('onSessionHydrated'), 'view must receive the hydrated snapshot');
	});

	test('retries past a failure and still lands the transcript', async () => {
		const { session, daemon } = makeSession('ses_1');
		daemon.responses.push({ success: false, error: 'serve not ready' });
		daemon.responses.push({ success: true, entries: [sdkEntry('msg_1', 'user', 'second try')] });

		const outcome = await resyncSessionFromServerIfNeeded(session, {
			frontendReady: true,
			sleep: noSleep,
			maxAttempts: 3,
		});

		assert.strictEqual(outcome, 'loaded');
		assert.strictEqual(daemon.calls.length, 2);
	});

	test('unbinds the session when every attempt yields nothing', async () => {
		const { session, daemon, channel } = makeSession('ses_1');
		// 三次「成功但为空」：transcript 还没惰性加载出来，和真失败一样可疑。
		daemon.responses.push({ success: true, entries: [] });
		daemon.responses.push({ success: true, entries: [] });
		daemon.responses.push({ success: true, entries: [] });

		const outcome = await resyncSessionFromServerIfNeeded(session, {
			frontendReady: true,
			sleep: noSleep,
			maxAttempts: 3,
		});

		assert.strictEqual(outcome, 'unbound');
		assert.strictEqual(daemon.calls.length, 3);
		assert.strictEqual(session.state.getSessionId(), null, 'ghost binding must be cleared');
		assert.ok(channel.lastCall('addErrorMessage'), 'user must be told why the conversation is gone');
	});
});

suite('ChatTabStore', () => {
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
			/** 测试辅助：预置一条持久化记录。 */
			seed: (key: string, value: unknown) => void data.set(key, value),
		};
	}

	test('round-trips the tab list and the active tab', () => {
		const store = new ChatTabStore(fakeMemento() as never);

		store.save({
			tabs: [
				{ id: 'tab_a', title: 'A', sessionId: 'ses_a' },
				{ id: 'tab_b', title: 'B', sessionId: null },
			],
			activeTabId: 'tab_b',
		});

		const loaded = store.load();
		assert.ok(loaded);
		assert.strictEqual(loaded.tabs.length, 2);
		assert.strictEqual(loaded.tabs[1].sessionId, null, 'draft tabs persist as drafts');
		assert.strictEqual(loaded.activeTabId, 'tab_b');
	});

	test('falls back to the first tab when the active id is unknown', () => {
		const store = new ChatTabStore(fakeMemento() as never);
		store.save({ tabs: [{ id: 'tab_a', title: 'A', sessionId: 'ses_a' }], activeTabId: 'tab_gone' });

		assert.strictEqual(store.load()?.activeTabId, 'tab_a');
	});

	test('ignores malformed persisted entries', () => {
		const memento = fakeMemento();
		memento.seed('opencode.chatTabs', {
			activeTabId: 'tab_ok',
			tabs: [
				{ title: 'no id' },
				{ id: 'tab_ok', sessionId: 'ses_ok', title: 'ok' },
				'garbage',
			],
		});
		const store = new ChatTabStore(memento as never);

		const loaded = store.load();
		assert.ok(loaded);
		assert.strictEqual(loaded.tabs.length, 1);
		assert.strictEqual(loaded.tabs[0].id, 'tab_ok');
		assert.strictEqual(loaded.tabs[0].sessionId, 'ses_ok');
	});

	test('returns null when nothing has been persisted yet', () => {
		assert.strictEqual(new ChatTabStore(fakeMemento() as never).load(), null);
	});
});

suite('notification title and preview', () => {
	test('prefixes the session name when available', () => {
		assert.strictEqual(buildNotificationTitle('修复登录', '任务已完成'), '【修复登录】任务已完成');
		assert.strictEqual(buildNotificationTitle('   ', '任务已完成'), '任务已完成');
		assert.strictEqual(buildNotificationTitle(null, '任务已完成'), '任务已完成');
	});

	test('uses the last text block of the last assistant message', () => {
		const messages = [
			createMessage(MessageType.USER, 'do it', { id: 'msg_1' }),
			createMessage(MessageType.ASSISTANT, 'I will check the logs. Checking...', {
				message: {
					content: [
						{ type: 'text', text: 'I will check the logs.' },
						{ type: 'tool_use', id: 'tool_1', name: 'Bash' },
						{ type: 'text', text: '```\nDone: 3 files changed\n```' },
					],
				},
			}),
		];

		const preview = buildNotificationPreview(messages, 'fallback');

		// 取最后一个 text block（最终答复），不是工具调用前的说明文字；代码围栏被折叠。
		assert.strictEqual(preview, 'Done: 3 files changed');
	});

	test('falls back when there is no assistant prose', () => {
		const messages = [createMessage(MessageType.USER, 'hi', { id: 'msg_1' })];
		assert.strictEqual(buildNotificationPreview(messages, '任务已完成'), '任务已完成');
	});

	test('condenses newlines and truncates long replies', () => {
		const long = `${'line\n'.repeat(200)}end`;
		const messages = [createMessage(MessageType.ASSISTANT, long, {
			message: { content: [{ type: 'text', text: long }] },
		})];
		const preview = buildNotificationPreview(messages, '');
		assert.ok(preview.length <= 220, `preview should be truncated, got ${preview.length}`);
		assert.ok(!preview.includes('\n'), 'preview must be a single line');
	});
});
