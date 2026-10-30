import './mockVscode';
import * as assert from 'assert';
import { ViewRegistry } from '../host/window/ViewRegistry';
import { ChatWindow } from '../host/window/ChatWindow';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { TabId } from '../host/tab/TabId';

class MockChannel implements WebviewChannel {
	public messages: unknown[] = [];
	public disposed = false;

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.messages.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return this.disposed;
	}

	public postRaw(message: unknown): void {
		if (!this.disposed) {
			this.messages.push(message);
		}
	}
}

suite('P3: Single Instance Multi-View (ChatWindow, ViewRegistry, TabEventRouter)', () => {
	suite('ViewRegistry', () => {
		test('registers and unregisters views and handles focus tracking', () => {
			let changedHost: string | null = null;
			const registry = new ViewRegistry((newHost) => {
				changedHost = newHost;
			});
			const ch1 = new MockChannel();
			const ch2 = new MockChannel();

			registry.register('sidebar', ch1);
			registry.register('panel', ch2);

			assert.strictEqual(registry.size(), 2);
			assert.strictEqual(registry.has('sidebar'), true);
			assert.strictEqual(registry.has('panel'), true);

			// Initially sidebar was registered first, so promptHost is sidebar
			assert.strictEqual(registry.getPromptHostId(), 'sidebar');

			// Focus panel
			registry.setFocused('panel', true);
			assert.strictEqual(registry.getPromptHostId(), 'panel');
			assert.strictEqual(changedHost, 'panel');

			// Unregister panel -> promptHost falls back to sidebar
			registry.unregister('panel');
			assert.strictEqual(registry.size(), 1);
			assert.strictEqual(registry.getPromptHostId(), 'sidebar');

			registry.unregister('sidebar');
			assert.strictEqual(registry.size(), 0);
			assert.strictEqual(registry.getPromptHostId(), null);
		});
	});

	suite('ChatWindow multi-view state sync and tab operations', () => {
		const dummyOptions = {
			settings: {} as any,
			daemon: {} as any,
			fileOps: {} as any,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
		};

		test('initializes with a default tab and resyncs on view.ready', async () => {
			const chatWindow = new ChatWindow(dummyOptions);
			const initialActiveTab = chatWindow.registry.getActiveTabId();
			assert.ok(initialActiveTab);
			assert.strictEqual(chatWindow.registry.size(), 1);

			// Attach first view and send view.ready
			const ch1 = new MockChannel();
			chatWindow.registerView('sidebar', ch1);
			await chatWindow.handleViewCommand('sidebar', { type: 'view.ready' });

			// Expect ch1 to receive host.events with tab.resync
			assert.ok(ch1.messages.length >= 1);
			const resyncBatch = ch1.messages.find((m: any) => {
				return m?.type === 'host.events' && Array.isArray(m?.batch) && m.batch.some((e: any) => e.type === 'tab.resync');
			}) as any;
			assert.ok(resyncBatch, 'Must receive tab.resync on view.ready');
			const resyncEvent = resyncBatch.batch.find((e: any) => e.type === 'tab.resync');
			assert.strictEqual(resyncEvent.payload.activeTabId, initialActiveTab.value);
			assert.strictEqual(resyncEvent.payload.tabs.length, 1);

			// Create a second tab via command
			const t2Id = TabId.create().value;
			await chatWindow.handleViewCommand('sidebar', {
				type: 'tab.create',
				tabId: t2Id,
			});
			assert.strictEqual(chatWindow.registry.size(), 2);
			assert.strictEqual(chatWindow.registry.getActiveTabId()?.value, t2Id);

			// Attach second view (e.g. editor panel) and send view.ready
			const ch2 = new MockChannel();
			chatWindow.registerView('editor-panel', ch2);
			await chatWindow.handleViewCommand('editor-panel', { type: 'view.ready' });

			const resync2 = ch2.messages.find((m: any) => {
				return m?.type === 'host.events' && Array.isArray(m?.batch) && m.batch.some((e: any) => e.type === 'tab.resync');
			}) as any;
			assert.ok(resync2);
			const resync2Event = resync2.batch.find((e: any) => e.type === 'tab.resync');
			assert.strictEqual(resync2Event.payload.activeTabId, t2Id);
			assert.strictEqual(resync2Event.payload.tabs.length, 2);

			chatWindow.eventRouter.dispose();
		});

		test('preserves tab state when views close and reopen', async () => {
			const chatWindow = new ChatWindow(dummyOptions);
			const tabId = chatWindow.registry.getActiveTabId()!.value;

			// Set user title
			await chatWindow.handleViewCommand('sidebar', {
				type: 'tab.title.set',
				tabId,
				title: 'Working Session',
			});

			// View 1 opens and closes
			const ch1 = new MockChannel();
			chatWindow.registerView('sidebar', ch1);
			await chatWindow.handleViewCommand('sidebar', { type: 'view.ready' });
			chatWindow.unregisterView('sidebar');

			// ViewRegistry has 0 views
			assert.strictEqual(chatWindow.viewRegistry.size(), 0);
			// But TabRegistry still preserves the tab and title
			assert.strictEqual(chatWindow.registry.size(), 1);
			assert.strictEqual(chatWindow.registry.get(TabId.of(tabId))?.getTitle(), 'Working Session');

			// Later View 2 opens
			const ch2 = new MockChannel();
			chatWindow.registerView('sidebar-reopened', ch2);
			await chatWindow.handleViewCommand('sidebar-reopened', { type: 'view.ready' });

			const resync = ch2.messages.find((m: any) => {
				return m?.type === 'host.events' && Array.isArray(m?.batch) && m.batch.some((e: any) => e.type === 'tab.resync');
			}) as any;
			assert.ok(resync);
			const resyncEvent = resync.batch.find((e: any) => e.type === 'tab.resync');
			assert.strictEqual(resyncEvent.payload.tabs[0].title, 'Working Session');

			chatWindow.eventRouter.dispose();
		});

		test('reorders and closes tabs correctly with fallback', async () => {
			const chatWindow = new ChatWindow(dummyOptions);
			const t1Id = chatWindow.registry.getActiveTabId()!.value;

			const t2Id = TabId.create().value;
			await chatWindow.handleViewCommand('v', { type: 'tab.create', tabId: t2Id });
			const t3Id = TabId.create().value;
			await chatWindow.handleViewCommand('v', { type: 'tab.create', tabId: t3Id });

			assert.strictEqual(chatWindow.registry.getActiveTabId()?.value, t3Id);

			// Reorder to [t3, t1, t2]
			await chatWindow.handleViewCommand('v', {
				type: 'tab.reorder',
				tabId: t1Id,
				payload: { tabIds: [t3Id, t1Id, t2Id] },
			});
			const order = chatWindow.registry.getOrder().map((t) => t.value);
			assert.deepStrictEqual(order, [t3Id, t1Id, t2Id]);

			// Close t3 -> activeTab falls back to its neighbour (left first, else right)
			await chatWindow.handleViewCommand('v', { type: 'tab.close', tabId: t3Id });
			assert.strictEqual(chatWindow.registry.size(), 2);
			assert.strictEqual(chatWindow.registry.getActiveTabId()?.value, t1Id);

			// Close the rest -> the registry really empties: the host never
			// materialises a replacement tab (idea's closeSession only deletes).
			await chatWindow.handleViewCommand('v', { type: 'tab.close', tabId: t1Id });
			await chatWindow.handleViewCommand('v', { type: 'tab.close', tabId: t2Id });
			assert.strictEqual(chatWindow.registry.size(), 0);
			assert.strictEqual(chatWindow.registry.getActiveTabId(), null);

			chatWindow.eventRouter.dispose();
		});

		test('closing every tab never resurrects the bootstrap tab', async () => {
			const chatWindow = new ChatWindow(dummyOptions);
			const ch = new MockChannel();
			chatWindow.registerView('v', ch);

			const ids = [
				chatWindow.registry.getActiveTabId()!.value,
				TabId.create().value,
				TabId.create().value,
			];
			for (const id of ids.slice(1)) {
				await chatWindow.handleViewCommand('v', { type: 'tab.create', tabId: id });
			}
			ch.messages.length = 0;

			// The webview's "close all" sends one tab.close per tab, then one
			// tab.create for the single replacement tab.
			for (const id of ids) {
				await chatWindow.handleViewCommand('v', { type: 'tab.close', tabId: id });
			}
			await new Promise((resolve) => setTimeout(resolve, 0));

			const events = ch.messages
				.flatMap((m: any) => (m?.type === 'host.events' && Array.isArray(m.batch) ? m.batch : []))
				.map((e: any) => ({ type: e.type as string, tabId: e.tabId as string }));
			const closedIds = events.filter((e) => e.type === 'tab.closed').map((e) => e.tabId);
			assert.deepStrictEqual(closedIds, ids);
			assert.deepStrictEqual(
				events.filter((e) => e.type === 'tab.created' || e.type === 'tab.activated'),
				[],
				'closing tabs must not create or activate anything',
			);
			assert.strictEqual(chatWindow.registry.size(), 0);

			const freshId = TabId.create().value;
			await chatWindow.handleViewCommand('v', { type: 'tab.create', tabId: freshId });
			assert.strictEqual(chatWindow.registry.size(), 1, 'exactly one replacement tab');
			assert.strictEqual(chatWindow.registry.getActiveTabId()?.value, freshId);
			assert.notStrictEqual(freshId, 'tab-1', 'the bootstrap identity must not come back');

			const later = ch.messages
				.flatMap((m: any) => (m?.type === 'host.events' && Array.isArray(m.batch) ? m.batch : []))
				.filter((e: any) => e.type === 'tab.created')
				.map((e: any) => e.tabId);
			assert.deepStrictEqual(later, [freshId], 'only the view-supplied tab is created');

			chatWindow.eventRouter.dispose();
		});

		test('validates protocol v2 and rejects invalid or duplicate commands', async () => {
			const chatWindow = new ChatWindow(dummyOptions);
			const ch = new MockChannel();
			chatWindow.registerView('v1', ch);
			const tabId = chatWindow.registry.getActiveTabId()!.value;

			const findLastRejected = () => {
				for (let i = ch.messages.length - 1; i >= 0; i--) {
					const m = ch.messages[i] as any;
					if (m?.type === 'host.events' && Array.isArray(m?.batch)) {
						const rej = m.batch.find((b: any) => b.type === 'command.rejected');
						if (rej) {
							return rej;
						}
					}
				}
				return null;
			};

			// 1. Unsupported version
			await chatWindow.handleViewCommand('v1', {
				v: 1,
				type: 'tab.close',
				tabId,
				requestId: 'req-1',
			});
			let rejected = findLastRejected();
			assert.ok(rejected);
			assert.strictEqual(rejected.payload.code, 'UNSUPPORTED_VERSION');

			// 2. Tab not found
			await chatWindow.handleViewCommand('v1', {
				v: 2,
				type: 'tab.close',
				tabId: 'tab-nonexistent-12345',
				requestId: 'req-2',
			});
			rejected = findLastRejected();
			assert.ok(rejected);
			assert.strictEqual(rejected.payload.code, 'TAB_NOT_FOUND');

			// 3. Duplicate requestId
			await chatWindow.handleViewCommand('v1', {
				v: 2,
				type: 'tab.title.set',
				tabId,
				requestId: 'req-dup',
				title: 'Title 1',
			});
			// Second call with same requestId
			await chatWindow.handleViewCommand('v1', {
				v: 2,
				type: 'tab.title.set',
				tabId,
				requestId: 'req-dup',
				title: 'Title 2',
			});
			rejected = findLastRejected();
			assert.ok(rejected);
			assert.strictEqual(rejected.payload.code, 'DUPLICATE_REQUEST');

			// 4. Draft synchronization
			await chatWindow.handleViewCommand('v1', {
				v: 2,
				type: 'tab.draft.changed',
				tabId,
				requestId: 'req-draft-1',
				draft: 'typing some prompt...',
			});
			assert.strictEqual(chatWindow.registry.get(TabId.of(tabId))?.getSettings().getDraft(), 'typing some prompt...');

			chatWindow.eventRouter.dispose();
		});
	});
});
