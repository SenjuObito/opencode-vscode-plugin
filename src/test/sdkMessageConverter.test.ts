import * as assert from 'assert';
import { convertSdkMessages, type SdkMessageEntry } from '../host/session/SdkMessageConverter';

suite('SdkMessageConverter Token and Usage normalization', () => {
	test('converts assistant tokens, cost and time into turnUsage, turnCostUsd and durationMs', () => {
		const entries: SdkMessageEntry[] = [
			{
				info: {
					id: 'msg_user_1',
					role: 'user',
					time: { created: 1000 },
				},
				parts: [{ type: 'text', text: 'Hello' }],
			},
			{
				info: {
					id: 'msg_asst_1',
					role: 'assistant',
					modelID: 'deepseek-v4-flash-free',
					cost: 0.0012,
					time: { created: 2000, completed: 3500 },
					tokens: {
						total: 20975,
						input: 158,
						output: 162,
						reasoning: 175,
						cache: {
							read: 20480,
							write: 0,
						},
					},
				},
				parts: [
					{ type: 'reasoning', text: 'Thinking process...' },
					{ type: 'text', text: 'Assistant reply.' },
				],
			},
		];

		const messages = convertSdkMessages(entries);
		assert.strictEqual(messages.length, 2);

		const assistantMsg = messages[1];
		assert.strictEqual(assistantMsg.type, 'assistant');
		assert.strictEqual(assistantMsg.timestamp, 2000);

		const raw = assistantMsg.raw as Record<string, unknown>;
		assert.ok(raw, 'raw should be present');
		assert.strictEqual(raw.durationMs, 1500);
		assert.strictEqual(raw.turnCostUsd, 0.0012);
		assert.strictEqual(raw.model, 'deepseek-v4-flash-free');

		const turnUsage = raw.turnUsage as Record<string, unknown>;
		assert.ok(turnUsage, 'turnUsage should be created');
		assert.strictEqual(turnUsage.input_tokens, 158);
		assert.strictEqual(turnUsage.output_tokens, 337);
		assert.strictEqual(turnUsage.reasoning_tokens, 175);
		assert.strictEqual(turnUsage.cache_read_input_tokens, 20480);
		assert.strictEqual(turnUsage.cache_creation_input_tokens, 0);
		assert.strictEqual(turnUsage.total_tokens, 20975);

		// Verify raw.message.usage is also populated for turnMetadataReconstruction compatibility
		const msgUsage = (raw.message as Record<string, unknown>)?.usage as Record<string, unknown>;
		assert.ok(msgUsage, 'raw.message.usage should be populated');
		assert.strictEqual(msgUsage.input_tokens, 158);
		assert.strictEqual(msgUsage.cache_read_input_tokens, 20480);
	});
});

suite('SdkMessageConverter compaction records', () => {
	test('converts a completed compaction into a transcript record with its summary and status', () => {
		const entries: SdkMessageEntry[] = [
			{
				info: {
					id: 'msg_compact_1',
					role: 'compaction',
					time: { created: 5000, completed: 6000 },
					compactionStatus: 'completed',
					compactionReason: 'manual',
					tokens: { total: 14582 },
				},
				parts: [{ type: 'text', text: '## Objective\n- ship it' }],
			},
		];

		const messages = convertSdkMessages(entries);
		assert.strictEqual(messages.length, 1);
		const message = messages[0];
		assert.strictEqual(message.type, 'compaction');
		assert.strictEqual(message.content, '## Objective\n- ship it');
		assert.strictEqual(message.timestamp, 5000);
		assert.strictEqual(message.compaction?.status, 'completed');
		assert.strictEqual(message.compaction?.reason, 'manual');
		assert.deepStrictEqual(message.compaction?.tokens, { total: 14582 });

		const raw = message.raw as Record<string, unknown>;
		assert.strictEqual(raw.type, 'compaction');
		assert.strictEqual(raw.id, 'msg_compact_1');
		assert.strictEqual(raw.uuid, 'msg_compact_1');
	});

	test('drops a failed compaction from history instead of replaying it as a card', () => {
		const entries: SdkMessageEntry[] = [
			{
				info: {
					id: 'msg_compact_failed',
					role: 'compaction',
					time: { created: 7000 },
					compactionStatus: 'failed',
					compactionReason: 'manual',
					error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
				},
				parts: [],
			},
		];

		const messages = convertSdkMessages(entries);
		assert.strictEqual(messages.length, 0);
	});

	test('normalizes a v1 assistant compaction message to a compaction record', () => {
		const entries: SdkMessageEntry[] = [
			{
				info: {
					id: 'msg_v1_compaction',
					role: 'assistant',
					isCompactSummary: true,
					time: { created: 9000 },
				},
				parts: [{ type: 'text', text: 'v1 summary' }],
			},
		];

		const messages = convertSdkMessages(entries);
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].type, 'compaction');
		assert.strictEqual(messages[0].content, 'v1 summary');
	});
});
