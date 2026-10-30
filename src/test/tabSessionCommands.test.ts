import './mockVscode';
import * as assert from 'assert';
import { TabSessionCommandHandler } from '../host/window/TabSessionCommandHandler';
import { TabRegistry } from '../host/tab/TabRegistry';
import { TabId } from '../host/tab/TabId';
import { TabCommand } from '../host/tab/TabCommand';
import { SessionState } from '../host/session/SessionState';
import { MessageType } from '../host/session/types';
import type { TabEvent } from '../host/tab/TabEvent';
import type { TabEventRouter } from '../host/window/TabEventRouter';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';
import type { OpenCodeSession } from '../host/session/OpenCodeSession';

interface Call { method: string; params: Record<string, unknown> }

function makeHarness(replies: Record<string, string>) {
	const calls: Call[] = [];
	const events: TabEvent[] = [];
	const bound: Array<{ targetTabId: string; sessionId: string }> = [];
	const registry = new TabRegistry();
	const state = new SessionState();
	const session = {
		state,
		getState: () => state,
		getAdapter: () => null,
		getCoalescer: () => null,
	} as unknown as OpenCodeSession;
	registry.create(TabId.of('tab-src'), '/workspace');
	registry.bind(TabId.of('tab-src'), 'ses_src', session, null, null);

	const daemon = {
		isAlive: () => true,
		request: (method: string, params: Record<string, unknown>, cb: {
			onLine: (line: string) => void;
			onError: (error: string) => void;
			onComplete: (success: boolean) => void;
		}) => {
			calls.push({ method, params });
			const reply = replies[method];
			if (reply) {
				cb.onLine(reply);
			}
			cb.onComplete(true);
			return Promise.resolve(true);
		},
	} as unknown as OpenCodeDaemonBridge;

	const eventRouter = {
		publish: (event: TabEvent) => events.push(event),
	} as unknown as TabEventRouter;

	const handler = new TabSessionCommandHandler({
		registry,
		eventRouter,
		daemon: () => daemon,
		resolveCwd: () => '/workspace',
		onForkBound: (targetTabId, sessionId) => bound.push({ targetTabId, sessionId }),
	});

	return { handler, calls, events, bound, registry, state };
}

suite('Tab session commands match the core method names', () => {
	test('fork uses opencode.fork and binds the reserved target tab', async () => {
		const h = makeHarness({ 'opencode.fork': '{"success":true,"newSessionId":"ses_new"}' });
		await h.handler.fork(TabCommand.of('tab-src', 'session.fork', 'r1', { targetTabId: 'tab-target' }));

		assert.strictEqual(h.calls[0]?.method, 'opencode.fork');
		assert.strictEqual(h.calls[0]?.params.sessionId, 'ses_src');
		assert.deepStrictEqual(h.bound, [{ targetTabId: 'tab-target', sessionId: 'ses_new' }]);
		const boundEvent = h.events.find((event) => event.type === 'session.fork.bound');
		assert.ok(boundEvent);
		assert.strictEqual(boundEvent!.tabId, 'tab-target');
		assert.strictEqual(boundEvent!.sessionId, 'ses_new');
	});

	test('compact uses opencode.summarize', () => {
		const h = makeHarness({ 'opencode.summarize': '{"success":true}' });
		h.handler.compact(TabCommand.of('tab-src', 'session.compact', 'r2', {}));
		assert.strictEqual(h.calls[0]?.method, 'opencode.summarize');
		assert.strictEqual(h.calls[0]?.params.sessionId, 'ses_src');
		assert.ok(h.events.some((event) => event.type === 'session.compact.done'));
	});

	test('share uses opencode.shareSession and publishes the url', () => {
		const h = makeHarness({ 'opencode.shareSession': '{"success":true,"share":{"url":"https://share.example/x"}}' });
		h.handler.share(TabCommand.of('tab-src', 'session.share', 'r3', {}));
		assert.strictEqual(h.calls[0]?.method, 'opencode.shareSession');
		const done = h.events.find((event) => event.type === 'session.share.done');
		assert.ok(done);
		assert.strictEqual(done!.payload.data, 'https://share.example/x');
	});

	test('refuses a command that names another session', () => {
		const h = makeHarness({ 'opencode.summarize': '{"success":true}' });
		h.handler.compact(TabCommand.of('tab-src', 'session.compact', 'r5', {
			sessionId: 'ses_other',
		}));
		assert.strictEqual(h.calls.length, 0);
		assert.ok(h.events.some((event) => event.type === 'session.compact.failed'));
	});

	test('revert publishes the resolved revert pointer', () => {
		const h = makeHarness({ 'opencode.revert': '{"success":true,"revert":{"messageID":"msg_1"}}' });
		h.handler.revert(TabCommand.of('tab-src', 'session.revert', 'r4', { messageId: 'msg_1' }));
		assert.strictEqual(h.calls[0]?.method, 'opencode.revert');
		assert.strictEqual(h.calls[0]?.params.messageID, 'msg_1');
		const changed = h.events.find((event) => event.type === 'revert.changed');
		assert.ok(changed);
		const state = JSON.parse(String(changed!.payload.state)) as { hasRevert: boolean; messageId: string };
		assert.deepStrictEqual(state, { hasRevert: true, messageId: 'msg_1' });
	});

	test('latest always resolves through listMessages, never an older local history id', () => {
		const h = makeHarness({
			'opencode.listMessages': [
				'{"messageEntry":{"info":{"role":"user","id":"msg_old"}}}',
				'{"messageEntry":{"info":{"role":"user","id":"msg_new"}}}',
			].join('\n'),
			'opencode.revert': '{"success":true,"revert":{"messageID":"msg_new"}}',
		});
		h.state.addMessage({
			type: MessageType.USER,
			content: 'older turn',
			timestamp: Date.now(),
			raw: { id: 'msg_old' },
		});

		h.handler.revert(TabCommand.of('tab-src', 'session.revert', 'r6', { messageId: 'latest' }));

		assert.deepStrictEqual(h.calls.map((call) => call.method), [
			'opencode.listMessages',
			'opencode.revert',
		]);
		assert.strictEqual(h.calls[1]?.params.messageID, 'msg_new');
	});
});
