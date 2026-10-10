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
		assert.strictEqual(turnUsage.output_tokens, 162);
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
