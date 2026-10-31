import './mockVscode';
import * as assert from 'assert';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabEvent } from '../host/tab/TabEvent';
import { TabId } from '../host/tab/TabId';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';

class MockChannel implements WebviewChannel {
	public messages: unknown[] = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.messages.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(message: unknown): void {
		this.messages.push(message);
	}
}

const dummyOptions = {
	settings: {} as any,
	daemon: {} as any,
	fileOps: {} as any,
	fallbackWorkingDirectoryResolver: () => '/mock/workspace',
};

function createWindow(): { chatWindow: ChatWindow; tabId: TabId } {
	const chatWindow = new ChatWindow(dummyOptions);
	const tabId = chatWindow.registry.getActiveTabId()!;
	return { chatWindow, tabId };
}

function publishTitle(
	chatWindow: ChatWindow,
	tabId: string,
	sessionId: string,
	title: unknown,
): void {
	const record = chatWindow.registry.get(TabId.of(tabId));
	assert.ok(record, `unknown tab ${tabId}`);
	record!.getEventSink()(new TabEvent({
		type: 'tab.title.changed',
		tabId,
		epoch: 0,
		sessionId,
		payload: { title },
		legacy: false,
	}));
}

function resyncTitles(chatWindow: ChatWindow): Array<{ tabId: string; title: string }> {
	const channel = new MockChannel();
	chatWindow.registerView('title-test', channel);
	const batch = channel.messages.find(
		(message): message is { type: 'host.events'; batch: Array<{ type: string; payload: any }> } =>
			typeof message === 'object'
			&& message !== null
			&& (message as { type?: string }).type === 'host.events'
			&& Array.isArray((message as { batch?: unknown[] }).batch),
	);
	assert.ok(batch, 'no host.events batch');
	const resync = batch!.batch.find((event) => event.type === 'tab.resync');
	assert.ok(resync, 'no tab.resync');
	return resync!.payload.tabs;
}

suite('Engine session titles', () => {
	test('applies an engine title to the owning tab and its resync snapshot', () => {
		const { chatWindow, tabId } = createWindow();
		const record = chatWindow.registry.require(tabId);
		chatWindow.registry.bind(tabId, 'ses_title', null, null, null);

		publishTitle(chatWindow, tabId.value, 'ses_title', 'Greeting');

		assert.strictEqual(record.getTitle(), 'Greeting');
		const tabs = resyncTitles(chatWindow);
		assert.strictEqual(tabs.find((tab) => tab.tabId === tabId.value)?.title, 'Greeting');

		chatWindow.eventRouter.dispose();
	});

	test('sanitizes newlines before storing the engine title', () => {
		const { chatWindow, tabId } = createWindow();
		const record = chatWindow.registry.require(tabId);
		chatWindow.registry.bind(tabId, 'ses_title', null, null, null);

		publishTitle(chatWindow, tabId.value, 'ses_title', '  Line one\r\nLine two  ');

		assert.strictEqual(record.getTitle(), 'Line one Line two');
		chatWindow.eventRouter.dispose();
	});

	test('ignores the engine placeholders', () => {
		const { chatWindow, tabId } = createWindow();
		const record = chatWindow.registry.require(tabId);
		chatWindow.registry.bind(tabId, 'ses_title', null, null, null);

		publishTitle(chatWindow, tabId.value, 'ses_title', 'New session - 2026-10-27T09:20:28.850Z');
		assert.strictEqual(record.getTitle(), '');
		publishTitle(chatWindow, tabId.value, 'ses_title', 'Child session - 2026-10-27T09:20:28.850Z');
		assert.strictEqual(record.getTitle(), '');

		chatWindow.eventRouter.dispose();
	});

	test('never lets a late engine title undo a user rename', () => {
		const { chatWindow, tabId } = createWindow();
		const record = chatWindow.registry.require(tabId);
		chatWindow.registry.bind(tabId, 'ses_title', null, null, null);
		record.getSettings().applyUserTitle('My own name');

		publishTitle(chatWindow, tabId.value, 'ses_title', 'Greeting');

		assert.strictEqual(record.getTitle(), 'My own name');
		chatWindow.eventRouter.dispose();
	});

	test('re-addresses a title to the tab that owns its session', () => {
		const { chatWindow, tabId: firstTab } = createWindow();
		const secondTab = chatWindow.registry.create(TabId.of('tab-title-owner'));
		chatWindow.registry.bind(secondTab.getTabId(), 'ses_second', null, null, null);
		chatWindow.registry.bind(firstTab, 'ses_first', null, null, null);

		// The adapter that carried the title names the wrong tab; the session
		// is authoritative, exactly like idea's applyTitleEvent.
		publishTitle(chatWindow, firstTab.value, 'ses_second', 'Second chat');

		assert.strictEqual(secondTab.getTitle(), 'Second chat');
		assert.strictEqual(chatWindow.registry.require(firstTab).getTitle(), '');
		chatWindow.eventRouter.dispose();
	});

	test('a title event carries the session it names, not the adapter binding', () => {
		const events: TabEvent[] = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: { callJavaScript: () => {} },
			eventSink: (event) => events.push(event),
			model: () => null,
		});
		adapter.setTabId('tab-a');
		adapter.setSessionId('ses_old');

		adapter.onSessionTitleReceived('ses_new', 'Greeting');

		const title = events.find((event) => event.type === 'tab.title.changed');
		assert.ok(title, 'tab.title.changed was not published');
		assert.strictEqual(title!.tabId, 'tab-a');
		assert.strictEqual(title!.sessionId, 'ses_new');
		assert.strictEqual(title!.payload.sessionId, 'ses_new');
	});
});
