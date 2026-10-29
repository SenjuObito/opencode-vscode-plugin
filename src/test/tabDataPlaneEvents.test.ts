import './mockVscode';
import * as assert from 'assert';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import type { TabEvent } from '../host/tab/TabEvent';
import { MessageType, type ChatMessage } from '../host/session/types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite('Tab data plane named events', () => {
	test('content delta carries tab/session identity and stays off the legacy bridge', async () => {
		const events: TabEvent[] = [];
		const legacy: string[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: (fn) => { legacy.push(fn); } },
			eventSink: (event) => events.push(event),
			model: () => null,
		});
		adapter.setTabId('tab-a');
		adapter.setSessionId('ses-1');

		adapter.onStreamStart();
		adapter.onContentDelta('hello');
		await wait(60);

		const delta = events.find((event) => event.type === 'content.delta');
		assert.ok(delta, 'content.delta was not published');
		assert.strictEqual(delta!.tabId, 'tab-a');
		assert.strictEqual(delta!.sessionId, 'ses-1');
		assert.strictEqual(delta!.payload.delta, 'hello');
		assert.strictEqual(delta!.legacy, false);
		assert.strictEqual(legacy.length, 0, 'legacy window.<fn> must not be used for a tab-scoped delta');
		adapter.dispose();
	});

	test('message snapshot carries tab identity, sequence and base index', () => {
		const events: TabEvent[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: () => {} },
			eventSink: (event) => events.push(event),
			model: () => null,
		});
		adapter.setTabId('tab-b');
		adapter.setSessionId('ses-2');

		const messages: ChatMessage[] = [
			{ type: MessageType.ASSISTANT, content: 'snapshot', timestamp: 1 },
		];
		adapter.onMessageUpdate(messages);
		adapter.getCoalescer().flush();

		const snapshot = events.find((event) => event.type === 'message.snapshot');
		assert.ok(snapshot, 'message.snapshot was not published');
		assert.strictEqual(snapshot!.tabId, 'tab-b');
		assert.strictEqual(snapshot!.sessionId, 'ses-2');
		assert.strictEqual(snapshot!.legacy, false);
		assert.ok(typeof snapshot!.payload.json === 'string');
		assert.ok(typeof snapshot!.payload.sequence === 'number');
		assert.strictEqual(snapshot!.payload.baseIndex, 0);
	});

	test('falls back to the legacy bridge when no tab is attached', async () => {
		const events: TabEvent[] = [];
		const legacy: string[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: (fn) => { legacy.push(fn); } },
			eventSink: (event) => events.push(event),
			model: () => null,
		});

		adapter.onContentDelta('single-session');
		await wait(60);

		assert.strictEqual(events.length, 0);
		assert.ok(legacy.includes('onContentDelta'));
		adapter.dispose();
	});
});
