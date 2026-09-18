import * as assert from 'assert';
import { WebviewBroadcaster } from '../host/router/WebviewBroadcaster';
import { WebviewChannel } from '../host/router/HandlerContext';
import { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';

class MockWebviewChannel implements WebviewChannel {
	readonly calls: { fn: string; args: string[] }[] = [];
	disposed = false;

	callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	postRaw(_message: unknown): void {}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
	}
}

suite('Daemon Lifecycle and Toast Tests', () => {
	test('WebviewBroadcaster broadcasts showToast to all active channels', () => {
		const channel1 = new MockWebviewChannel();
		const channel2 = new MockWebviewChannel();

		const unregister1 = WebviewBroadcaster.register(channel1);
		const unregister2 = WebviewBroadcaster.register(channel2);

		try {
			const errorMsg = 'OpenCode 服务启动失败：SyntaxError test';
			WebviewBroadcaster.broadcastJavaScript('showToast', errorMsg);

			assert.strictEqual(channel1.calls.length, 1);
			assert.strictEqual(channel1.calls[0].fn, 'showToast');
			assert.strictEqual(channel1.calls[0].args[0], errorMsg);

			assert.strictEqual(channel2.calls.length, 1);
			assert.strictEqual(channel2.calls[0].fn, 'showToast');
			assert.strictEqual(channel2.calls[0].args[0], errorMsg);
		} finally {
			unregister1();
			unregister2();
		}
	});

	test('OpenCodeDaemonBridge correctly reports isAlive and isStarting initially', () => {
		const bridge = new OpenCodeDaemonBridge({
			daemonScriptPath: '/fake/path/daemon.js',
		});

		assert.strictEqual(bridge.isAlive(), false);
		assert.strictEqual(bridge.isStarting(), false);
	});
});
