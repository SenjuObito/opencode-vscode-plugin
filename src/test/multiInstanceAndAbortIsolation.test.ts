import * as assert from 'assert';
import { WebviewBroadcaster } from '../host/router/WebviewBroadcaster';
import { WebviewChannel, FileOps } from '../host/router/HandlerContext';
import { ProviderWebviewChannel } from '../host/webview/OpenCodeViewProvider';
import { SingleWebviewChannel } from '../host/tabs/TabManager';
import { createChatInstance } from '../host/session/ChatInstance';
import { SettingsService, SettingsStore } from '../host/settings/SettingsService';
import { EditorContextTracker } from '../host/context/EditorContextTracker';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';

interface RecordedCall {
	fn: string;
	args: string[];
}

class FakeWebviewChannel implements WebviewChannel {
	readonly calls: RecordedCall[] = [];
	readonly rawMessages: unknown[] = [];
	disposed = false;

	callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	postRaw(message: unknown): void {
		this.rawMessages.push(message);
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
	}
}

function createFakeSettingsStore(): SettingsStore {
	const global = new Map<string, unknown>();
	const workspace = new Map<string, unknown>();
	return {
		getGlobal: (key) => global.get(key),
		setGlobal: (key, value) => void global.set(key, value),
		getWorkspace: (key) => workspace.get(key),
		setWorkspace: (key, value) => void workspace.set(key, value),
	};
}

suite('WebviewBroadcaster', () => {
	test('broadcasts JavaScript calls to all registered active channels', () => {
		const channel1 = new FakeWebviewChannel();
		const channel2 = new FakeWebviewChannel();

		const unregister1 = WebviewBroadcaster.register(channel1);
		const unregister2 = WebviewBroadcaster.register(channel2);

		WebviewBroadcaster.broadcastJavaScript('addSelectionInfo', '@file.ts#L1-L10');

		assert.strictEqual(channel1.calls.length, 1);
		assert.strictEqual(channel1.calls[0].fn, 'addSelectionInfo');
		assert.deepStrictEqual(channel1.calls[0].args, ['@file.ts#L1-L10']);

		assert.strictEqual(channel2.calls.length, 1);
		assert.strictEqual(channel2.calls[0].fn, 'addSelectionInfo');
		assert.deepStrictEqual(channel2.calls[0].args, ['@file.ts#L1-L10']);

		unregister1();
		unregister2();
	});

	test('skips disposed channels and unregisters cleanly', () => {
		const channelActive = new FakeWebviewChannel();
		const channelDisposed = new FakeWebviewChannel();
		channelDisposed.dispose();

		const unregisterActive = WebviewBroadcaster.register(channelActive);
		const unregisterDisposed = WebviewBroadcaster.register(channelDisposed);

		WebviewBroadcaster.broadcastJavaScript('onIdeThemeChanged', '{"isDark":true}');

		assert.strictEqual(channelActive.calls.length, 1);
		assert.strictEqual(channelDisposed.calls.length, 0);

		unregisterActive();
		unregisterDisposed();
	});
});

suite('ProviderWebviewChannel and SingleWebviewChannel', () => {
	test('ProviderWebviewChannel is not disposed before explicit dispose() even with 0 attached views', () => {
		const channel = new ProviderWebviewChannel();
		assert.strictEqual(channel.isDisposed(), false);
		assert.strictEqual(channel.getViewCount(), 0);

		channel.dispose();
		assert.strictEqual(channel.isDisposed(), true);
	});

	test('SingleWebviewChannel routes postMessage to underlying webview correctly', () => {
		const posted: unknown[] = [];
		const fakeWebview = {
			postMessage: (msg: unknown) => {
				posted.push(msg);
				return Promise.resolve(true);
			},
		};

		const channel = new SingleWebviewChannel(fakeWebview as any);
		assert.strictEqual(channel.isDisposed(), false);

		channel.callJavaScript('addSelectionInfo', '@test.kt');
		assert.strictEqual(posted.length, 1);
		assert.deepStrictEqual(posted[0], { type: 'addSelectionInfo', args: ['@test.kt'] });

		channel.dispose();
		assert.strictEqual(channel.isDisposed(), true);

		channel.callJavaScript('addSelectionInfo', '@after_dispose.kt');
		assert.strictEqual(posted.length, 1);
	});
});

suite('createChatInstance Assembly', () => {
	test('registers ExportHandler in dispatcher and sets up editor context hooks', () => {
		const channel = new FakeWebviewChannel();
		const settings = new SettingsService(createFakeSettingsStore(), ['/workspace']);
		const fakeDaemon = {} as OpenCodeDaemonBridge;
		const fakeFileOps: FileOps = {
			openFile: () => {},
			resolveFilePath: (p) => p,
			openExternal: () => {},
			copyToClipboard: () => true,
		};
		const tracker = new EditorContextTracker(settings);

		const instance = createChatInstance({
			channel,
			settings,
			daemon: fakeDaemon,
			fileOps: fakeFileOps,
			fallbackWorkingDirectoryResolver: () => '/workspace',
			editorContextTracker: tracker,
		});

		// 验证 ExportHandler 已正确注册到当前实例的 dispatcher
		const canHandleExportMarkdown = instance.dispatcher.dispatch('export_session_markdown', '{}');
		assert.strictEqual(canHandleExportMarkdown, true);

		const canHandleExportSession = instance.dispatcher.dispatch('export_session', '{}');
		assert.strictEqual(canHandleExportSession, true);

		// 验证未注册的类型返回 false
		assert.strictEqual(instance.dispatcher.dispatch('unknown_type', '{}'), false);

		instance.dispose();
		tracker.dispose();
	});
});
