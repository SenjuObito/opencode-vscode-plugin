import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabId } from '../host/tab/TabId';
import { TabEvent } from '../host/tab/TabEvent';

class MockChannel implements WebviewChannel {
	public raw: unknown[] = [];
	public disposed = false;

	public callJavaScript(): void {}

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

function makeChatWindow(): ChatWindow {
	return new ChatWindow({
		settings: {
			getPrimaryWorkspaceRoot: () => '/mock/workspace',
			getAutoOpenFileEnabled: () => false,
		} as never,
		daemon: {} as never,
		fileOps: {} as never,
		fallbackWorkingDirectoryResolver: () => '/mock/workspace',
		createSession: () => null,
	});
}

const published = (channel: MockChannel): TabEvent[] =>
	channel.raw.flatMap((message) => ((message as { batch?: TabEvent[] })?.batch ?? []));

/**
 * The host is the only layer that knows the session↔tab binding.
 *
 * <p>A publisher that only knows the session (core's canonical todo state, an
 * adapter that outlived a rebind) must still reach the owning tab, because the
 * webview routes strictly by `tabId` and never reverse-looks-up a session. The
 * publish choke point re-addresses the event; these cases pin that.</p>
 */
suite('Host event addressing: session -> owning tab', () => {
	test('an event published through a stale adapter reaches the owning tab', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = TabId.of('tab-owner-a');
		const tabB = TabId.of('tab-owner-b');
		chatWindow.registry.create(tabA, '/mock/workspace');
		chatWindow.registry.create(tabB, '/mock/workspace');
		chatWindow.registry.bind(tabA, 'ses_owner_a', null, null, null);
		chatWindow.registry.bind(tabB, 'ses_owner_b', null, null, null);

		// tabA's record still carries tabA, but the payload belongs to ses-owner-b:
		// exactly what a late tick from a rebound adapter looks like.
		const staleSink = chatWindow.registry.get(tabA)!.getEventSink();
		staleSink(new TabEvent({
			type: 'todos.updated',
			tabId: tabA.value,
			sessionId: 'ses_owner_b',
			epoch: 0,
			payload: { todos: '{"todos":[]}' },
		}));

		await new Promise((resolve) => setTimeout(resolve, 0));

		const todo = published(view).find((event) => event.type === 'todos.updated');
		assert.ok(todo, 'todos.updated was not published');
		assert.strictEqual(todo!.tabId, tabB.value, 'the owning tab must win over the adapter tab');
		assert.strictEqual(todo!.sessionId, 'ses_owner_b');
	});

	test('an event without a session keeps its own tab', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = TabId.of('tab-keep-a');
		chatWindow.registry.create(tabA, '/mock/workspace');
		chatWindow.registry.bind(tabA, 'ses_keep_a', null, null, null);

		chatWindow.registry.get(tabA)!.getEventSink()(new TabEvent({
			type: 'session.loading',
			tabId: tabA.value,
			epoch: 0,
			payload: { loading: true },
		}));

		await new Promise((resolve) => setTimeout(resolve, 0));

		const loading = published(view).find((event) => event.type === 'session.loading');
		assert.ok(loading, 'session.loading was not published');
		assert.strictEqual(loading!.tabId, tabA.value);
	});

	test('an unbound session is not guessed onto another tab', async () => {
		const chatWindow = makeChatWindow();
		const view = new MockChannel();
		chatWindow.registerView('sidebar', view);

		const tabA = TabId.of('tab-guess-a');
		chatWindow.registry.create(tabA, '/mock/workspace');
		chatWindow.registry.bind(tabA, 'ses_guess_a', null, null, null);

		chatWindow.registry.get(tabA)!.getEventSink()(new TabEvent({
			type: 'todos.updated',
			tabId: '',
			sessionId: 'ses_nowhere',
			epoch: 0,
			payload: { todos: '[]' },
		}));

		await new Promise((resolve) => setTimeout(resolve, 0));

		const todo = published(view).find((event) => event.type === 'todos.updated');
		assert.ok(todo, 'todos.updated was not published');
		assert.strictEqual(todo!.tabId, '', 'an unknown session must not be attributed to a tab');
	});
});
