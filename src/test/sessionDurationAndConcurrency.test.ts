import * as assert from 'assert';
import { SessionState } from '../host/session/SessionState';
import { CallbackHandler } from '../host/session/CallbackHandler';
import { MessageHandler } from '../host/session/MessageHandler';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import { MessageType, ChatMessage } from '../host/session/types';
import { convertMessagesToJson } from '../host/util/MessageJsonConverter';
import { processOutputLine, MarkerStreamContext } from '../host/session/MarkerParser';

suite('Session Duration and Background Completion Tests', () => {
	test('MessageHandler stamps durationMs on assistant message upon stream end', () => {
		const state = new SessionState();
		const callbackHandler = new CallbackHandler();
		const messageHandler = new MessageHandler(state, callbackHandler);
		const streamCtx: MarkerStreamContext = {
			assistantContent: '',
			hadSendError: false,
			lastNodeError: null,
			wasAborted: false,
		};

		const startTime = Date.now() - 1500;
		state.setActiveTurnStartTime(startTime);

		// Simulate user message then streaming assistant message
		processOutputLine('[STREAM_START]', messageHandler, streamCtx);
		processOutputLine('[CONTENT_DELTA] "Hello world"', messageHandler, streamCtx);
		processOutputLine('[STREAM_END]', messageHandler, streamCtx);

		const messages = state.getMessages();
		assert.strictEqual(messages.length, 1);
		const assistantMsg = messages[0];
		assert.strictEqual(assistantMsg.type, MessageType.ASSISTANT);
		assert.strictEqual(assistantMsg.content, 'Hello world');
		assert.ok(typeof assistantMsg.durationMs === 'number', 'durationMs should be a number');
		assert.ok(assistantMsg.durationMs! >= 1400, `durationMs (${assistantMsg.durationMs}) should be >= 1400`);

		const rawObj = assistantMsg.raw as Record<string, unknown>;
		assert.ok(rawObj !== null && typeof rawObj === 'object');
		assert.strictEqual(rawObj.durationMs, assistantMsg.durationMs);

		// Verify JSON conversion preserves durationMs
		const jsonStr = convertMessagesToJson(messages);
		const parsed = JSON.parse(jsonStr);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].durationMs, assistantMsg.durationMs);
	});
});

