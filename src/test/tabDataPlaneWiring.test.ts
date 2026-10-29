import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import { SessionState } from '../host/session/SessionState';
import { TabId } from '../host/tab/TabId';
import type { OpenCodeSession, SendMessagePayload } from '../host/session/OpenCodeSession';
import type { WebviewChannel } from '../host/router/HandlerContext';
import type { JsTarget } from '../host/session/SessionCallbackAdapter';

class RawChannel implements WebviewChannel {
	public raw: Array<Record<string, unknown>> = [];
	public calls: Array<{ fn: string; args: string[] }> = [];
	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}
	public isDisposed(): boolean { return false; }
	public postRaw(message: unknown): void { this.raw.push(message as Record<string, unknown>); }
	public getViewCount(): number { return 1; }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

suite('Tab data plane wiring', () => {
	test('a tab session publishes named streaming events through the router', async () => {
		let adapter: SessionCallbackAdapter | null = null;
		const state = new SessionState();
		const chatWindow = new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			createSession: (sink: JsTarget, _auto, _ctx, eventSink) => {
				adapter = new SessionCallbackAdapter({
					jsTarget: sink,
					eventSink,
					model: () => state.getModel(),
					windowBaseIndex: () => state.getWindowBaseIndex(),
				});
				const session = {
					state,
					getState: () => state,
					getAdapter: () => adapter,
					setCallback: () => {},
					send: async (_payload: SendMessagePayload) => {},
					sendShell: async () => {},
					interrupt: () => {},
					dispose: () => {},
				} as unknown as OpenCodeSession;
				return session;
			},
		});
		const channel = new RawChannel();
		chatWindow.registerView('view-1', channel);

		const tabId = chatWindow.registry.getActiveTabId()!;
		await chatWindow.handleViewCommand('view-1', {
			v: 2,
			type: 'session.send',
			requestId: 'send-1',
			tabId: tabId.value,
			sessionId: null,
			payload: { text: 'hello' },
		});
		await tick();

		const activeAdapter = adapter as SessionCallbackAdapter | null;
		assert.ok(activeAdapter, 'session adapter was not created');
		activeAdapter!.onStreamStart();
		activeAdapter!.onContentDelta('world');
		await new Promise((resolve) => setTimeout(resolve, 60));
		await tick();

		const batches = channel.raw
			.filter((message) => message.type === 'host.events')
			.flatMap((message) => (message.batch as Array<Record<string, unknown>>) ?? []);
		const delta = batches.find((event) => event.type === 'content.delta');
		assert.ok(delta, 'content.delta never reached the view');
		assert.strictEqual(delta!.tabId, tabId.value);
		assert.deepStrictEqual(delta!.payload, { delta: 'world' });
		assert.strictEqual(delta!.legacy, false);
	});
});
