import './mockVscode';
import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatWindow } from '../host/window/ChatWindow';
import { TabId } from '../host/tab/TabId';
import { TabQueue } from '../host/tab/TabQueue';
import { TabState } from '../host/tab/TabState';
import type { TabRecord } from '../host/tab/TabRecord';
import { SessionState } from '../host/session/SessionState';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import { attachWindowCommands } from './windowDispatcherHarness';
import type { OpenCodeSession, SendMessagePayload } from '../host/session/OpenCodeSession';
import type { WebviewChannel } from '../host/router/HandlerContext';
import type { JsTarget } from '../host/session/SessionCallbackAdapter';
import type { TabEventSink } from '../host/tab/TabEvent';

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

	public events(): Array<Record<string, unknown>> {
		return this.raw
			.filter((message) => message.type === 'host.events')
			.flatMap((message) => (message.batch as Array<Record<string, unknown>>) ?? []);
	}
}

interface FakeSession {
	sent: SendMessagePayload[];
	shells: string[];
	interrupts: number;
	disposed: number;
	session: OpenCodeSession;
}

function makeSessionFactory(): {
	create: (sink: JsTarget, eventSink?: TabEventSink) => OpenCodeSession;
	all: FakeSession[];
	fakeOf: (session: OpenCodeSession) => FakeSession;
} {
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
	const fakeOf = (session: OpenCodeSession): FakeSession => {
		const found = all.find((entry) => entry.session === session);
		assert.ok(found, 'session must come from this factory');
		return found;
	};
	return { create, all, fakeOf };
}

interface DeferredDaemonCall {
	method: string;
	params: Record<string, unknown>;
	/** Answer the request; `reply` is the JSON line handed to the handler. */
	complete: (reply?: string, success?: boolean) => void;
}

interface FakeDaemon {
	alive: boolean;
	isAlive: () => boolean;
	/** Methods answered immediately with this JSON line. */
	replies: Record<string, string>;
	/** Methods left pending so a test can answer them later. */
	calls: DeferredDaemonCall[];
	request: (
		method: string,
		params: Record<string, unknown>,
		cb: {
			onLine: (line: string) => void;
			onError: (error: string) => void;
			onComplete: (success: boolean) => void;
		},
	) => Promise<boolean>;
}

interface Harness {
	chatWindow: ChatWindow;
	view: MockChannel;
	factory: ReturnType<typeof makeSessionFactory>;
	root: string;
	/** Flipped by the tests to model the daemon going away and coming back. */
	daemon: FakeDaemon;
}

function makeHarness(root: string): Harness {
	const factory = makeSessionFactory();
	const daemon: FakeDaemon = {
		alive: true,
		isAlive: () => daemon.alive,
		replies: {},
		calls: [],
		// The queued-command tests need the request/response path the real
		// daemon bridge exposes; everything else only checks liveness.
		request: (method, params, cb) => {
			const direct = daemon.replies[method];
			if (direct !== undefined) {
				cb.onLine(direct);
				cb.onComplete(true);
				return Promise.resolve(true);
			}
			daemon.calls.push({
				method,
				params,
				complete: (reply, success = true) => {
					if (reply) {
						cb.onLine(reply);
					}
					cb.onComplete(success);
				},
			});
			return Promise.resolve(true);
		},
	};
	const chatWindow = new ChatWindow({
		settings: {} as never,
		daemon: daemon as never,
		fileOps: {} as never,
		attachmentsRoot: root,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
		createSession: (sink, _auto, _ctx, eventSink) => factory.create(sink, eventSink),
	});
	chatWindow.setWindowCommandDispatcher(attachWindowCommands(chatWindow, daemon));
	const view = new MockChannel();
	chatWindow.registerView('sidebar', view);
	return { chatWindow, view, factory, root, daemon };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function run(
	chatWindow: ChatWindow,
	type: string,
	tabId: string,
	payload: Record<string, unknown>,
	sessionId: string | null = null,
): Promise<void> {
	await chatWindow.handleViewCommand('sidebar', {
		v: 2,
		type,
		requestId: `${type}-${Math.random().toString(36).slice(2)}`,
		tabId,
		sessionId,
		payload,
	});
	await tick();
}

function recordOf(chatWindow: ChatWindow, tabId: TabId): TabRecord {
	const record = chatWindow.registry.get(tabId);
	assert.ok(record, `tab ${tabId.value} must exist`);
	return record;
}

function bindSession(chatWindow: ChatWindow, factory: ReturnType<typeof makeSessionFactory>, tabId: string, sessionId: string): FakeSession {
	const record = recordOf(chatWindow, TabId.of(tabId));
	const session = chatWindow.ensureTabSession(record);
	assert.ok(session, `tab ${tabId} must get a session`);
	// `bindTabSession` listens for the id the server assigns.
	(session.state as SessionState).setSessionId(sessionId);
	return factory.fakeOf(session);
}

async function enqueue(
	chatWindow: ChatWindow,
	tabId: string,
	id: string,
	text: string,
	attachments?: Array<{ attachmentId: string; fileName?: string; mediaType?: string }>,
): Promise<void> {
	await run(chatWindow, 'queue.enqueue', tabId, {
		item: { id, text, attachments, createdAt: Date.now() },
	});
}

async function enqueueCommand(
	chatWindow: ChatWindow,
	tabId: string,
	id: string,
	command: string,
	commandArgs?: Record<string, unknown>,
	model?: string,
): Promise<void> {
	await run(chatWindow, 'queue.enqueue', tabId, {
		item: { id, text: command, command, commandArgs, model, createdAt: Date.now() },
	});
}

suite('P8: per-tab host-owned message queue', () => {
	suite('TabQueue', () => {
		test('take is atomic: a duplicated drain cannot send twice', () => {
			const queue = new TabQueue();
			queue.enqueue({ id: 'q1', text: 'one', originSessionId: null, originTabEpoch: 0, createdAt: 1 });

			assert.strictEqual(queue.take()?.id, 'q1');
			assert.strictEqual(queue.take(), null, 'inflight must block a second take');
			queue.complete();
			assert.strictEqual(queue.isEmpty(), true);
		});

		test('the projection lists only waiting items', () => {
			const queue = new TabQueue();
			queue.enqueue({ id: 'q1', text: 'one', originSessionId: null, originTabEpoch: 0, createdAt: 1 });
			queue.enqueue({ id: 'q2', text: 'two', originSessionId: null, originTabEpoch: 0, createdAt: 2 });

			assert.deepStrictEqual(queue.toJson().items.map((item) => item.id), ['q1', 'q2']);

			// The item being sent leaves the queue; the view must not list it again.
			queue.take();

			assert.deepStrictEqual(queue.toJson().items.map((item) => item.id), ['q2']);
		});

		test('a failed send goes back to the head and stops the pump', () => {
			const queue = new TabQueue();
			queue.enqueue({ id: 'q1', text: 'one', originSessionId: null, originTabEpoch: 0, createdAt: 1 });
			queue.enqueue({ id: 'q2', text: 'two', originSessionId: null, originTabEpoch: 0, createdAt: 2 });

			queue.take();
			queue.fail('boom');

			assert.strictEqual(queue.getInflightId(), null);
			assert.deepStrictEqual(queue.items().map((item) => item.id), ['q1', 'q2']);
			assert.strictEqual(queue.getError()?.message, 'boom');

			queue.remove('q1');
			assert.strictEqual(queue.getError(), null, 'removing the failed item clears the banner');
		});

		test('a confirmed resume retries the failed item instead of stalling', () => {
			const queue = new TabQueue();
			queue.enqueue({ id: 'q1', text: 'one', originSessionId: null, originTabEpoch: 0, createdAt: 1 });
			queue.take();
			queue.fail('boom');
			queue.pause();

			queue.resume();

			assert.strictEqual(queue.isPaused(), false);
			assert.strictEqual(queue.getError(), null, 'the failure banner must not outlive the confirmation');
			assert.strictEqual(queue.take()?.id, 'q1', 'the same item is retried');
		});

		test('clearAll drops pending and in-flight items', () => {
			const queue = new TabQueue();
			queue.enqueue({ id: 'q1', text: 'one', originSessionId: null, originTabEpoch: 0, createdAt: 1 });
			queue.enqueue({ id: 'q2', text: 'two', originSessionId: null, originTabEpoch: 0, createdAt: 2 });
			queue.take();

			const { removed } = queue.clearAll();
			assert.deepStrictEqual(removed.map((item) => item.id), ['q1', 'q2']);
			assert.strictEqual(queue.isEmpty(), true);
		});

		test('refuses an oversized queue and duplicate ids', () => {
			const queue = new TabQueue();
			for (let index = 0; index < TabQueue.MAX_ITEMS; index += 1) {
				const queued = queue.enqueue({
					id: `q${index}`,
					text: `item ${index}`,
					originSessionId: null,
					originTabEpoch: 0,
					createdAt: index,
				});
				assert.strictEqual(queued.ok, true);
			}
			const overflow = queue.enqueue({
				id: 'overflow', text: 'x', originSessionId: null, originTabEpoch: 0, createdAt: 0,
			});
			assert.strictEqual(overflow.ok, false);
			const duplicate = queue.enqueue({
				id: 'q0', text: 'x', originSessionId: null, originTabEpoch: 0, createdAt: 0,
			});
			assert.strictEqual(duplicate.ok, false);
		});
	});

	suite('TabQueuePump (single consumer)', () => {
		let root = '';

		setup(() => {
			root = mkdtempSync(join(tmpdir(), 'oc-queue-'));
		});

		teardown(() => {
			rmSync(root, { recursive: true, force: true });
		});

		test('a busy tab keeps its item even after another tab becomes active', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const tabB = h.chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const sessionB = bindSession(h.chatWindow, h.factory, tabB.value, 'ses_b');

			// A's turn is running; the user switches to B while A's message queues.
			(sessionA.session.state as SessionState).setBusy(true);
			h.chatWindow.registry.activate(tabB);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'hello from A');

			assert.strictEqual(sessionA.sent.length, 0);
			assert.strictEqual(sessionB.sent.length, 0);
			assert.strictEqual(recordOf(h.chatWindow, tabA).queue.size(), 1);

			// A settles while B is on screen: it must still go to A.
			(sessionA.session.state as SessionState).setBusy(false);
			h.chatWindow.queuePump.onTabSettled(recordOf(h.chatWindow, tabA));
			await tick();

			assert.strictEqual(sessionA.sent.length, 1, 'A must receive the queued message');
			assert.strictEqual(sessionA.sent[0].text, 'hello from A');
			assert.strictEqual((sessionA.sent[0] as { sessionId?: string }).sessionId, 'ses_a');
			assert.strictEqual(sessionB.sent.length, 0, 'B must never receive A\'s message');
		});

		test('attachments are resolved against the owning tab, not the active one', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const tabB = h.chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			bindSession(h.chatWindow, h.factory, tabB.value, 'ses_b');

			const base64 = Buffer.from('hello').toString('base64');
			await run(h.chatWindow, 'attachment.prepare', tabA.value, {
				attachmentId: 'att-a', fileName: 'note.txt', mediaType: 'text/plain', size: 5,
			});
			await run(h.chatWindow, 'attachment.chunk', tabA.value, {
				attachmentId: 'att-a', offset: 0, data: base64,
			});
			await run(h.chatWindow, 'attachment.complete', tabA.value, { attachmentId: 'att-a' });

			(sessionA.session.state as SessionState).setBusy(true);
			h.chatWindow.registry.activate(tabB);
			await enqueue(h.chatWindow, tabA.value, 'a-att', 'see attached', [
				{ attachmentId: 'att-a', fileName: 'note.txt', mediaType: 'text/plain' },
			]);

			(sessionA.session.state as SessionState).setBusy(false);
			h.chatWindow.queuePump.onTabSettled(recordOf(h.chatWindow, tabA));
			await tick();

			assert.strictEqual(sessionA.sent.length, 1);
			assert.strictEqual(sessionA.sent[0].attachments?.[0]?.data, base64);
			assert.strictEqual(sessionA.sent[0].attachments?.[0]?.fileName, 'note.txt');
		});

		test('one turn at a time: FIFO within a tab', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');

			await enqueue(h.chatWindow, tabA.value, 'a-1', 'first');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'second');

			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['first']);
			assert.strictEqual(recordOf(h.chatWindow, tabA).queue.size(), 1);

			h.chatWindow.queuePump.onTabSettled(recordOf(h.chatWindow, tabA));
			await tick();
			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['first', 'second']);
		});

		test('a brand-new tab sends its first message immediately', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;

			await enqueue(h.chatWindow, tabA.value, 'a-1', 'first ever');

			const record = recordOf(h.chatWindow, tabA);
			assert.strictEqual(record.queue.size(), 0, 'nothing is left pending');
			assert.strictEqual(record.queue.getInflightId(), 'a-1');
			const session = record.getSession();
			assert.ok(session);
			const sent = h.factory.fakeOf(session).sent;
			assert.deepStrictEqual(sent.map((payload) => payload.text), ['first ever']);
		});

		test('interrupt pauses the queue until the user resumes it', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');

			(sessionA.session.state as SessionState).setBusy(true);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'queued one');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'queued two');
			const record = recordOf(h.chatWindow, tabA);
			assert.strictEqual(record.queue.size(), 2);

			await run(h.chatWindow, 'session.interrupt', tabA.value, {});
			assert.strictEqual(sessionA.interrupts, 1);
			assert.strictEqual(record.queue.isPaused(), true);

			// The turn settles now, but a stop is an explicit decision: no send.
			(sessionA.session.state as SessionState).setBusy(false);
			h.chatWindow.queuePump.onTabSettled(record);
			await tick();
			assert.strictEqual(sessionA.sent.length, 0);

			await run(h.chatWindow, 'queue.resume', tabA.value, {});
			await tick();
			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['queued one']);
		});

		test('switching conversations drops the queue instead of delivering it', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');

			(sessionA.session.state as SessionState).setBusy(true);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'written in ses_a');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'also ses_a');
			const record = recordOf(h.chatWindow, tabA);
			assert.strictEqual(record.queue.size(), 2);

			h.chatWindow.switchActiveTabSession(null);
			await tick();

			assert.strictEqual(record.queue.isEmpty(), true, 'the new conversation starts empty');
			assert.strictEqual(sessionA.sent.length, 0, 'nothing is delivered into the new conversation');
			assert.ok(
				h.view.events().some((event) => event.type === 'message.error'),
				'the user must be told the queue was cleared',
			);
		});

		test('closing a tab clears its queue', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');

			(sessionA.session.state as SessionState).setBusy(true);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'queued');
			const record = recordOf(h.chatWindow, tabA);
			assert.strictEqual(record.queue.size(), 1);

			await run(h.chatWindow, 'tab.close', tabA.value, {});
			assert.strictEqual(record.queue.isEmpty(), true);
		});

		test('a send naming another tab\'s session is refused', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const tabB = h.chatWindow.registry.create(TabId.of('tab-b'), '/mock/workspace').getTabId();
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const sessionB = bindSession(h.chatWindow, h.factory, tabB.value, 'ses_b');

			await run(h.chatWindow, 'session.send', tabB.value, { text: 'wrong owner' }, 'ses_a');

			assert.strictEqual(sessionA.sent.length, 0);
			assert.strictEqual(sessionB.sent.length, 0);
			const rejected = h.view.events().find((event) => event.type === 'command.rejected');
			assert.ok(rejected, 'the refusal must be visible');
			assert.strictEqual(
				(rejected!.payload as Record<string, unknown>).code,
				'SESSION_MISMATCH',
			);
		});

		test('a daemon death consumes the in-flight item and keeps the rest', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			(sessionA.session.state as SessionState).setBusy(true);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'in flight');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'still pending');
			record.queue.take();
			assert.strictEqual(record.queue.getInflightId(), 'a-1');

			h.chatWindow.handleDaemonDied();

			assert.strictEqual(record.queue.getInflightId(), null, 'the dead turn is consumed');
			assert.deepStrictEqual(record.queue.items().map((item) => item.id), ['a-2']);
		});

		test('a queued command runs between the prompts around it', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			(sessionA.session.state as SessionState).setBusy(true);
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'first');
			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/compact');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'third');

			assert.deepStrictEqual(record.queue.items().map((item) => item.command), [undefined, '/compact', undefined]);
			assert.ok(
				!h.view.events().some((event) => event.type === 'session.compact.started'),
				'a queued compact has not started yet',
			);

			(sessionA.session.state as SessionState).setBusy(false);
			h.chatWindow.queuePump.onTabSettled(record);
			await tick();
			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['first']);

			// The first turn ends: the command runs before the next prompt.
			h.chatWindow.queuePump.onTabSettled(record);
			await tick();
			assert.strictEqual(record.queue.getInflightCommand(), '/compact');
			assert.strictEqual(record.queue.isCompacting(), true);
			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['first'],
				'nothing overtakes the in-flight command');
			assert.deepStrictEqual(record.queue.items().map((item) => item.id), ['a-2']);
			assert.strictEqual(
				h.view.events().filter((event) => event.type === 'session.compact.started').length,
				1,
			);
			assert.strictEqual(h.daemon.calls[0]?.method, 'opencode.summarize');

			h.daemon.calls[0].complete('{"success":true}');
			await tick();

			assert.deepStrictEqual(sessionA.sent.map((payload) => payload.text), ['first', 'third']);
			assert.strictEqual(record.queue.getInflightCommand(), null);
			assert.strictEqual(record.queue.isCompacting(), false);
		});

		test('a command result without its request id cannot release the item', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/compact');
			assert.strictEqual(record.queue.getInflightCommand(), '/compact');

			h.chatWindow.queuePump.onCommandSettled(record, ['/compact'], 'not-mine', true);
			assert.strictEqual(record.queue.getInflightCommand(), '/compact');

			h.chatWindow.queuePump.onCommandSettled(record, ['/compact'], 'c-1', true);
			assert.strictEqual(record.queue.getInflightId(), null);
		});

		test('a failed command stays at the head until the user continues', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/compact');
			assert.strictEqual(record.queue.getInflightCommand(), '/compact');

			h.daemon.calls[0].complete(undefined, false);
			await tick();

			assert.strictEqual(record.queue.getInflightId(), null);
			assert.deepStrictEqual(record.queue.items().map((item) => item.id), ['c-1']);
			assert.ok(record.queue.getError());
			assert.strictEqual(record.queue.isCompacting(), false);

			await run(h.chatWindow, 'queue.resume', tabA.value, {});
			await tick();

			assert.strictEqual(record.queue.getError(), null);
			assert.strictEqual(record.queue.getInflightCommand(), '/compact', 'the command is retried');
			assert.strictEqual(h.daemon.calls.length, 2);
		});

		test('a queued undo keeps the message id frozen at enqueue time', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/undo', { messageId: 'msg_frozen' });

			assert.strictEqual(h.daemon.calls[0]?.method, 'opencode.revert',
				'an explicit id must not be re-resolved through listMessages');
			assert.strictEqual(h.daemon.calls[0]?.params.messageID, 'msg_frozen');

			h.daemon.calls[0].complete('{"success":true,"revert":{"messageID":"msg_frozen"}}');
			await tick();

			assert.strictEqual(record.queue.getInflightId(), null, 'revert.changed settles the command');
			assert.strictEqual(record.queue.isEmpty(), true);
		});

		test('a queued compact keeps the model frozen at enqueue time', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');

			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/compact', undefined, 'openai/gpt-5');

			assert.strictEqual(h.daemon.calls[0]?.method, 'opencode.summarize');
			assert.strictEqual(h.daemon.calls[0]?.params.model, 'openai/gpt-5');
		});

		test('an unknown command string is never queued', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			await enqueueCommand(h.chatWindow, tabA.value, 'c-1', '/drop-tables');

			assert.strictEqual(record.queue.isEmpty(), true);
			assert.strictEqual(record.queue.getInflightId(), null);
		});

		test('a message queued after picking a history session runs once that load finishes', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			// `session.load` binds the tab and parks it in LOADING_HISTORY until
			// the transcript is in (TabSessionFactory.attachSession).
			h.chatWindow.registry.bind(
				tabA, 'ses_a', sessionA.session, sessionA.session.getAdapter(), null,
			);
			h.chatWindow.registry.markLoadingHistory(tabA);

			await enqueue(h.chatWindow, tabA.value, 'a-1', 'after picking a session');

			assert.strictEqual(record.getState(), TabState.LOADING_HISTORY);
			assert.strictEqual(sessionA.sent.length, 0, 'the history load still holds the queue');

			// The transcript arrives: HistoryHandler.markHistoryLoaded releases
			// the tab, and the waiting message may finally be sent.
			h.chatWindow.createTabSessionContext().markHistoryLoaded('ses_a');
			await tick();

			assert.strictEqual(record.getState(), TabState.BOUND);
			assert.deepStrictEqual(
				sessionA.sent.map((payload) => payload.text),
				['after picking a session'],
			);
		});

		test('the items kept through an outage resume when the daemon is back', async () => {
			const h = makeHarness(root);
			const tabA = h.chatWindow.registry.getActiveTabId()!;
			const sessionA = bindSession(h.chatWindow, h.factory, tabA.value, 'ses_a');
			const record = recordOf(h.chatWindow, tabA);

			h.daemon.alive = false;
			await enqueue(h.chatWindow, tabA.value, 'a-1', 'first');
			await enqueue(h.chatWindow, tabA.value, 'a-2', 'second');
			assert.strictEqual(sessionA.sent.length, 0, 'a dead daemon cannot take an item');
			assert.strictEqual(record.queue.size(), 2);

			h.chatWindow.handleDaemonDied();
			h.daemon.alive = true;
			h.chatWindow.handleDaemonReady();
			await tick();

			assert.strictEqual(sessionA.sent.length, 1, 'the restart wakes the quiet tab');
			assert.strictEqual(sessionA.sent[0].text, 'first');
			assert.strictEqual(record.queue.getInflightId(), 'a-1');
			assert.deepStrictEqual(record.queue.items().map((item) => item.id), ['a-2'],
				'the next item still waits for this turn to settle');
		});
	});
});
