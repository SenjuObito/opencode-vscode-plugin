import * as assert from 'assert';
import { processOutputLine, type MarkerStreamContext } from '../host/session/MarkerParser';
import type { MessageCallback, SDKResult } from '../host/session/MessageHandler';

/**
 * Core publishes the canonical subagent terminal state as
 * `[SUBAGENT_STATUS] {json}`. The host parser is the first hop; without this
 * branch the event is silently dropped and the StatusPanel can never leave
 * `running` for a background child (the old transcript polling was the only,
 * late, fallback).
 */
suite('MarkerParser subagent status marker', () => {
	const newContext = (): MarkerStreamContext => ({
		assistantContent: '',
		hadSendError: false,
		lastNodeError: null,
		wasAborted: false,
	});

	const recorder = () => {
		const seen: Array<{ type: string; content: string }> = [];
		const callback: MessageCallback = {
			onMessage(type: string, content: string) {
				seen.push({ type, content });
			},
			onError() {
				// not exercised here
			},
			onComplete(_result: SDKResult) {
				// not exercised here
			},
		};
		return { seen, callback };
	};

	test('routes [SUBAGENT_STATUS] as subagent_status with the JSON payload intact', () => {
		const { seen, callback } = recorder();
		const payload = {
			parentSessionId: 'ses_parent',
			toolUseId: 'call_1',
			childSessionId: 'ses_child',
			status: 'completed',
			summary: 'child finished',
		};

		processOutputLine(`[SUBAGENT_STATUS] ${JSON.stringify(payload)}`, callback, newContext());

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].type, 'subagent_status');
		assert.deepStrictEqual(JSON.parse(seen[0].content), payload);
	});

	test('does not confuse the marker with a generic [STATUS] retry payload', () => {
		const { seen, callback } = recorder();
		const payload = { toolUseId: 'call_2', status: 'failed' };

		processOutputLine(`[SUBAGENT_STATUS] ${JSON.stringify(payload)}`, callback, newContext());

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].type, 'subagent_status');
		assert.strictEqual(JSON.parse(seen[0].content).status, 'failed');
	});
});
