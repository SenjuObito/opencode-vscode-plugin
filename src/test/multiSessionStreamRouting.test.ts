import './mockVscode';
import * as assert from 'assert';
import { TabId } from '../host/tab/TabId';
import { SessionId } from '../host/tab/SessionId';
import { TabSessionActor } from '../host/tab/TabSessionActor';
import { PendingSend } from '../host/tab/PendingSend';
import { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';

describe('Multi-Session Stream Routing and Concurrency (P2)', () => {
	it('TabSessionActor provides intra-tab serialization and cross-tab concurrency', async () => {
		const tabA = TabId.of('tab-a');
		const tabB = TabId.of('tab-b');
		const actorA = new TabSessionActor(tabA);
		const actorB = new TabSessionActor(tabB);

		const events: string[] = [];

		// Tab A task 1 (takes 30ms)
		actorA.submit(async () => {
			await new Promise((r) => setTimeout(r, 30));
			events.push('A1');
		});

		// Tab A task 2
		actorA.submit(async () => {
			events.push('A2');
		});

		// Tab B task 1 (takes 10ms, should complete BEFORE A1 because they run concurrently)
		actorB.submit(async () => {
			await new Promise((r) => setTimeout(r, 10));
			events.push('B1');
		});

		// Tab B task 2
		actorB.submit(async () => {
			events.push('B2');
		});

		// Wait for both actors to complete
		await new Promise((r) => setTimeout(r, 80));

		// B finished its work before A because A1 had a longer delay,
		// but within A: A1 precedes A2; within B: B1 precedes B2.
		assert.strictEqual(events[0], 'B1');
		assert.strictEqual(events[1], 'B2');
		assert.strictEqual(events[2], 'A1');
		assert.strictEqual(events[3], 'A2');
	});

	it('OpenCodeDaemonBridge routes lines strictly by session identity', () => {
		const bridge = new OpenCodeDaemonBridge({
			daemonScriptPath: '/dummy/daemon.js',
		});

		const linesA: string[] = [];
		const linesB: string[] = [];

		bridge.registerSessionSink('ses_A', {
			onLine: (l) => linesA.push(l),
		});

		bridge.registerSessionSink('ses_B', {
			onLine: (l) => linesB.push(l),
		});

		// Simulate daemon output with identity markers
		// Line for session A
		(bridge as any).deliverDataLine('ses_A', 'req-1', 'line A1', (bridge as any).daemonContext);
		// Line for session B
		(bridge as any).deliverDataLine('ses_B', 'req-2', 'line B1', (bridge as any).daemonContext);
		// Another line for session A
		(bridge as any).deliverDataLine('ses_A', 'req-1', 'line A2', (bridge as any).daemonContext);

		assert.deepStrictEqual(linesA, ['line A1', 'line A2']);
		assert.deepStrictEqual(linesB, ['line B1']);
		assert.strictEqual(bridge.getOrphanLineCount(), 0, 'No lines should be orphaned when sinks are registered');

		// Unregister session A (e.g. Tab A closed)
		bridge.unregisterSessionSink('ses_A');

		// New line for session A should now be buffered as orphan and counted
		(bridge as any).deliverDataLine('ses_A', 'req-3', 'line A3', (bridge as any).daemonContext);
		assert.strictEqual(linesA.length, 2, 'Session A should not receive line after unregister');
		assert.strictEqual(bridge.getOrphanLineCount(), 1, 'Orphan line count should increment');
	});

	it('PendingSend buffers bootstrap lines and flushes upon session registration', () => {
		const bridge = new OpenCodeDaemonBridge({
			daemonScriptPath: '/dummy/daemon.js',
		});

		let markerFired = '';
		const pending = new PendingSend('req-new', 'tab-new', (marker) => {
			markerFired = marker;
		});

		bridge.registerPendingSend(pending);

		// Lines arrive before [SESSION_ID]
		(bridge as any).deliverDataLine(null, 'req-new', 'thinking...', (bridge as any).daemonContext);
		// [SESSION_ID] arrives
		(bridge as any).deliverDataLine(null, 'req-new', '[SESSION_ID] "ses_created"', (bridge as any).daemonContext);
		// Further line arrives stamped with session
		(bridge as any).deliverDataLine('ses_created', 'req-new', 'response chunk 1', (bridge as any).daemonContext);

		assert.strictEqual(markerFired, '[SESSION_ID] "ses_created"');
		assert.strictEqual(pending.sessionId, 'ses_created');

		// Now host registers sink for ses_created
		const sessionLines: string[] = [];
		bridge.registerSessionSink('ses_created', {
			onLine: (l) => sessionLines.push(l),
		});

		// The pre-bind line 'thinking...' and post-marker 'response chunk 1' must be flushed to the sink
		assert.ok(sessionLines.includes('thinking...'), 'Buffered pre-session line should be flushed');
		assert.ok(sessionLines.includes('response chunk 1'), 'Post-marker line should be delivered');

		pending.complete();
		bridge.unregisterPendingSend(pending);
	});
});
