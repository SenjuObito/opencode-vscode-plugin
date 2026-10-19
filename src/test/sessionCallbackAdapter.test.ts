import * as assert from 'assert';

import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';

/**
 * 真实 sessionId 到达时，必须把「旧临时键」一起下发给 webview。
 *
 * webview 的 tab 在服务端分配 id 之前绑的是宿主临时键（tabId / 客户端 UUID）。
 * 少了第二参，前端只能猜「当前未绑定的 tab」，后台会话的 id 就会落到新建的
 * 草稿 tab 上（标题/消息串会话）。
 */
suite('SessionCallbackAdapter', () => {
	test('onSessionIdReceived passes the previous temporary key to the webview', () => {
		const calls: Array<{ fn: string; args: string[] }> = [];
		const adapter = new SessionCallbackAdapter({
			jsTarget: {
				callJavaScript: (fn: string, ...args: string[]) => {
					calls.push({ fn, args });
				},
			},
			model: () => null,
		});

		adapter.setSessionId('tab-123');
		adapter.onSessionIdReceived('ses_real');

		const call = calls.find((c) => c.fn === 'setSessionId');
		assert.ok(call, 'setSessionId must reach the webview');
		assert.deepStrictEqual(call!.args, ['ses_real', 'tab-123']);
	});
});
