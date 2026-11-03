import * as assert from 'assert';
import { SessionState } from '../host/session/SessionState';
import { MessageType } from '../host/session/types';

/**
 * The compaction record is the only transcript row the command plane and the
 * engine lifecycle both write. These tests pin the "upsert, never duplicate"
 * contract: a running record is reused by a second start, a terminal event
 * updates it in place, and a late/duplicate terminal never appends another.
 */
suite('SessionState compaction records', () => {
	test('a second begin reuses the running record instead of appending', () => {
		const state = new SessionState();

		const first = state.beginCompaction('manual', 'input-1');
		const second = state.beginCompaction('auto', 'input-1');

		assert.strictEqual(first, second);
		assert.strictEqual(state.getMessages().length, 1);
		assert.strictEqual(state.getMessages()[0].type, MessageType.COMPACTION);
		assert.strictEqual(state.getMessages()[0].compaction?.status, 'in_progress');
		// The first trigger wins: a later engine signal cannot relabel a manual
		// /compact as automatic.
		assert.strictEqual(state.getMessages()[0].compaction?.reason, 'manual');
	});

	test('a terminal event updates the running record in place', () => {
		const state = new SessionState();
		state.beginCompaction('manual', 'input-1');

		state.finishCompaction('completed', {
			id: 'msg_compact_1',
			summary: '## Objective\n- ship it',
			reason: 'manual',
		});

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].compaction?.status, 'completed');
		assert.strictEqual(messages[0].content, '## Objective\n- ship it');
		const raw = messages[0].raw as Record<string, unknown>;
		assert.strictEqual(raw.id, 'msg_compact_1');
		assert.strictEqual(raw.uuid, 'msg_compact_1');
		assert.strictEqual(state.hasActiveCompaction(), false);
	});

	test('a duplicate / late terminal keeps exactly one record', () => {
		const state = new SessionState();
		state.beginCompaction('manual', 'input-1');
		state.finishCompaction('completed', { id: 'msg_compact_1', summary: 'first' });

		// The summarize RPC result lands after the engine's ended marker.
		state.finishCompaction('completed', { id: 'msg_compact_1' });
		// A replayed ended with the full summary lands even later.
		state.finishCompaction('completed', { id: 'msg_compact_1', summary: 'first, completed' });
		// A terminal with no summary (the turn-level echo) must not erase it.
		state.finishCompaction('completed', { id: 'msg_compact_1', summary: '' });

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].content, 'first, completed');
		assert.strictEqual(messages[0].compaction?.status, 'completed');
	});

	test('a terminal without a start appends one completed record (missed started)', () => {
		const state = new SessionState();

		state.finishCompaction('completed', {
			id: 'msg_compact_history',
			summary: 'summary',
			reason: 'auto',
		});

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].type, MessageType.COMPACTION);
		assert.strictEqual(messages[0].compaction?.status, 'completed');
		assert.strictEqual(messages[0].content, 'summary');
	});

	test('a terminal whose id matches a loaded record updates it instead of appending', () => {
		const state = new SessionState();
		state.addMessage({
			type: MessageType.COMPACTION,
			content: 'loaded summary',
			timestamp: 1000,
			raw: { type: 'compaction', id: 'msg_compact_1', uuid: 'msg_compact_1' },
			compaction: { status: 'completed', reason: 'auto' },
		});

		state.finishCompaction('completed', { id: 'msg_compact_1', summary: 'updated summary' });

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].content, 'updated summary');
	});

	test('a failure closes the running record and keeps the reason', () => {
		const state = new SessionState();
		state.beginCompaction('manual');

		state.finishCompaction('failed', { error: 'Nothing to compact yet' });

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].compaction?.status, 'failed');
		assert.strictEqual(messages[0].compaction?.error, 'Nothing to compact yet');
		assert.strictEqual(messages[0].compaction?.reason, 'manual');
	});

	test('a new compaction after a completed one creates a second record', () => {
		const state = new SessionState();
		state.beginCompaction('auto');
		state.finishCompaction('completed', { summary: 'one' });
		state.beginCompaction('auto');

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].compaction?.status, 'completed');
		assert.strictEqual(messages[1].compaction?.status, 'in_progress');
	});
});
