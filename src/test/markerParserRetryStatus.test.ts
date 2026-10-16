import * as assert from 'assert';
import { processOutputLine, type MarkerStreamContext } from '../host/session/MarkerParser';
import type { MessageCallback, SDKResult } from '../host/session/MessageHandler';

/**
 * Retry / quota surfacing at the marker layer.
 *
 * The daemon reports "why is this turn spinning" as `[STATUS]` (opencode's
 * session.status with type=retry, carrying a human-readable reason plus a
 * clickable action) and reports a late real failure as `[TURN_ERROR]`.
 *
 * Both used to be lost on the host: `[STATUS]` had no parser branch at all, and
 * the late error was mis-routed to the compaction-result channel (logged and
 * dropped). The user's only feedback was the generic local 180s timeout, which
 * never named the exhausted quota.
 */
suite('MarkerParser retry / quota markers', () => {
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

	test('routes a structured [STATUS] payload as retry_status', () => {
		const { seen, callback } = recorder();
		const payload = JSON.stringify({
			sessionID: 'ses_1',
			type: 'retry',
			message: 'Free usage exceeded, subscribe to Go',
			attempt: 3,
			next: 1792140000000,
			action: { reason: 'free_tier_limit', label: 'subscribe', link: 'https://opencode.ai/go' },
		});

		processOutputLine(`[STATUS] ${payload}`, callback, newContext());

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].type, 'retry_status');
		assert.ok(seen[0].content.includes('free_tier_limit'));
	});

	test('ignores the [STATUS] preconnect chatter printed by the daemon', () => {
		const { seen, callback } = recorder();

		// The daemon also prints "[STATUS] preconnect ready sessionId=..." straight
		// to stdout. Routing it would surface internal warm-up noise as a toast.
		processOutputLine('[STATUS] preconnect ready sessionId=ses_1', callback, newContext());

		assert.strictEqual(seen.length, 0);
	});

	test('routes [TURN_ERROR] as turn_error', () => {
		const { seen, callback } = recorder();
		const payload = JSON.stringify({
			sessionID: 'ses_1',
			message: 'Rate limit exceeded',
			source: 'late-after-timeout',
		});

		processOutputLine(`[TURN_ERROR] ${payload}`, callback, newContext());

		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].type, 'turn_error');
		assert.ok(seen[0].content.includes('Rate limit exceeded'));
	});
});
