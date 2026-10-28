import * as assert from 'assert';
import { TabId } from '../host/tab/TabId';
import { SessionId } from '../host/tab/SessionId';
import { TurnId } from '../host/tab/TurnId';
import { TabRegistry } from '../host/tab/TabRegistry';
import { TabState } from '../host/tab/TabState';
import { TabCommand } from '../host/tab/TabCommand';
import { TabCommandRouter, TabCommandRouteResult } from '../host/tab/TabCommandRouter';

describe('Tab models and Registry invariants', () => {
	it('TabId validates non-empty and enforces identity', () => {
		assert.throws(() => new TabId(''), /tabId must not be blank/);
		assert.throws(() => new TabId('   '), /tabId must not be blank/);

		const id1 = TabId.create();
		const id2 = TabId.of(id1.value);
		assert.ok(id1.value.startsWith('tab-'));
		assert.ok(id1.equals(id2));
	});

	it('SessionId validates ses_* prefix (INV-2)', () => {
		assert.throws(() => new SessionId('invalid_session_id'), /not a canonical opencode session id/);
		assert.throws(() => new SessionId(''), /sessionId must not be blank/);

		const valid = new SessionId('ses_123456');
		assert.strictEqual(valid.value, 'ses_123456');
		assert.strictEqual(SessionId.tryParse('invalid'), null);
		assert.strictEqual(SessionId.tryParse('ses_abc')?.value, 'ses_abc');
	});

	it('TurnId parses numbers correctly', () => {
		assert.throws(() => new TurnId(NaN), /turnId must be a valid number/);
		const turn1 = TurnId.of(1042);
		assert.strictEqual(turn1.toNumber(), 1042);
		assert.strictEqual(TurnId.tryParse('2048')?.toNumber(), 2048);
		assert.strictEqual(TurnId.tryParse('not-a-number'), null);
	});

	it('TabRegistry handles tab lifecycle and bi-directional index (INV-3)', () => {
		const registry = new TabRegistry();
		const tabA = TabId.of('tab-a');
		const tabB = TabId.of('tab-b');

		const recA = registry.create(tabA, '/cwd/a');
		assert.strictEqual(recA.getState(), TabState.NEW);
		assert.strictEqual(registry.getActiveTabId()?.value, 'tab-a');

		const recB = registry.create(tabB, '/cwd/b');
		assert.strictEqual(registry.size(), 2);

		// Bind session ses_1 to tabA
		const ses1 = SessionId.of('ses_1');
		registry.bind(tabA, ses1, null, null, null);
		assert.strictEqual(recA.getState(), TabState.BOUND);
		assert.strictEqual(recA.getSessionId()?.value, 'ses_1');
		assert.strictEqual(registry.findBySession(ses1)?.getTabId().value, 'tab-a');

		// Idempotent rebind of same session to same tab
		registry.bind(tabA, ses1, null, null, null);

		// Binding different session to already bound tab should throw
		assert.throws(() => {
			registry.bind(tabA, SessionId.of('ses_different'), null, null, null);
		}, /already bound/);

		// Binding already bound session to different tab should throw
		assert.throws(() => {
			registry.bind(tabB, ses1, null, null, null);
		}, /already owned/);

		// Close tabA releases indexes (INV-6)
		const closed = registry.close(tabA);
		assert.ok(closed);
		assert.strictEqual(closed?.isClosed(), true);
		assert.strictEqual(registry.findBySession(ses1), null);
		assert.strictEqual(registry.get(tabA), null);
		// Active tab automatically switched to tabB
		assert.strictEqual(registry.getActiveTabId()?.value, 'tab-b');
	});

	it('TabRegistry produces accurate snapshots and supports reordering', () => {
		const registry = new TabRegistry();
		const tab1 = TabId.of('tab-1');
		const tab2 = TabId.of('tab-2');
		const tab3 = TabId.of('tab-3');

		const r1 = registry.create(tab1);
		const r2 = registry.create(tab2);
		const r3 = registry.create(tab3);

		r1.getSettings().applyUserTitle('First Chat');
		r2.getSettings().applyAutoTitle('Second Chat');
		r3.getSettings().applyAutoTitle('Third Chat');
		registry.markStreaming(tab2, true);

		const snapshots = registry.snapshots();
		assert.strictEqual(snapshots.length, 3);
		assert.strictEqual(snapshots[0].title, 'First Chat');
		assert.strictEqual(snapshots[0].active, true);
		assert.strictEqual(snapshots[1].streaming, true);
		assert.strictEqual(snapshots[1].active, false);

		// Reorder
		registry.reorder([tab3, tab1, tab2]);
		const newOrder = registry.getOrder().map((t) => t.value);
		assert.deepStrictEqual(newOrder, ['tab-3', 'tab-1', 'tab-2']);

		const reorderedSnapshots = registry.snapshots();
		assert.strictEqual(reorderedSnapshots[0].tabId, 'tab-3');
		assert.strictEqual(reorderedSnapshots[1].tabId, 'tab-1');
		assert.strictEqual(reorderedSnapshots[2].tabId, 'tab-2');
	});

	it('TabCommandRouter routes commands with actor ordering and request deduplication', async () => {
		const registry = new TabRegistry();
		const router = new TabCommandRouter(registry);
		const tabId = TabId.of('tab-test');
		registry.create(tabId);

		const order: number[] = [];
		router.register('test.action', async (cmd) => {
			const num = cmd.number('num') ?? 0;
			// Add slight simulated async delay
			await new Promise((r) => setTimeout(r, 10));
			order.push(num);
		});

		// Send 3 commands concurrently with unique requestIds
		const r1 = await router.route(TabCommand.of(tabId, 'test.action', 'req-1', { num: 1 }));
		const r2 = await router.route(TabCommand.of(tabId, 'test.action', 'req-2', { num: 2 }));
		const r3 = await router.route(TabCommand.of(tabId, 'test.action', 'req-3', { num: 3 }));

		assert.strictEqual(r1, TabCommandRouteResult.ROUTED);
		assert.strictEqual(r2, TabCommandRouteResult.ROUTED);
		assert.strictEqual(r3, TabCommandRouteResult.ROUTED);

		// Wait for actor queue to drain
		await new Promise((r) => setTimeout(r, 60));
		assert.deepStrictEqual(order, [1, 2, 3], 'Actor must execute tasks sequentially');

		// Sending duplicate requestId should return DUPLICATE without re-executing
		const dup = await router.route(TabCommand.of(tabId, 'test.action', 'req-1', { num: 100 }));
		assert.strictEqual(dup, TabCommandRouteResult.DUPLICATE);
		assert.deepStrictEqual(order, [1, 2, 3]);

		// Unknown command or unknown tab
		const unknownCmd = await router.route(TabCommand.of(tabId, 'unknown.type', 'req-4'));
		assert.strictEqual(unknownCmd, TabCommandRouteResult.UNKNOWN_COMMAND);

		const unknownTab = await router.route(TabCommand.of('non-existent-tab', 'test.action', 'req-5'));
		assert.strictEqual(unknownTab, TabCommandRouteResult.UNKNOWN_TAB);
	});
});
