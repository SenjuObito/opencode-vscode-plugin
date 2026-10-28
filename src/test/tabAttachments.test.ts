import './mockVscode';
import * as assert from 'assert';
import { mkdtempSync, existsSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatWindow } from '../host/window/ChatWindow';
import { TabId } from '../host/tab/TabId';
import { TabAttachmentStore, MAX_ATTACHMENT_BYTES, sanitizeFileName } from '../host/attachments/TabAttachmentStore';
import { SessionState } from '../host/session/SessionState';
import { SessionCallbackAdapter } from '../host/session/SessionCallbackAdapter';
import type { OpenCodeSession, SendMessagePayload } from '../host/session/OpenCodeSession';
import type { WebviewChannel } from '../host/router/HandlerContext';
import type { JsTarget } from '../host/session/SessionCallbackAdapter';

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(): void {}

	public getViewCount(): number {
		return 1;
	}
}

function makeTempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'oc-attach-'));
}

describe('P8 §10.10: 附件链路（按 tab 落盘 + 只发 id）', () => {
	describe('TabAttachmentStore', () => {
		it('prepare → chunk → complete 后可从磁盘读回', () => {
			const root = makeTempRoot();
			try {
				const store = new TabAttachmentStore(root);
				const payload = Buffer.from('hello world').toString('base64');

				assert.strictEqual(store.prepare('tab-a', {
					attachmentId: 'att-1',
					fileName: 'note.txt',
					mediaType: 'text/plain',
					size: 11,
				}), null);
				assert.strictEqual(store.chunk('tab-a', 'att-1', 0, payload), null);
				assert.strictEqual(store.complete('tab-a', 'att-1'), null);

				const resolved = store.resolve('tab-a', 'att-1');
				assert.ok(resolved);
				assert.strictEqual(resolved.fileName, 'note.txt');
				assert.strictEqual(resolved.mediaType, 'text/plain');
				assert.strictEqual(resolved.size, 11);
				assert.strictEqual(
					Buffer.from(store.readBase64('tab-a', 'att-1')!, 'base64').toString(),
					'hello world',
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it('分块乱序被拒（offset 必须连续）', () => {
			const root = makeTempRoot();
			try {
				const store = new TabAttachmentStore(root);
				store.prepare('tab-a', { attachmentId: 'att-2', fileName: 'a.bin', mediaType: '', size: 8 });
				const failure = store.chunk('tab-a', 'att-2', 4, Buffer.from('abcd').toString('base64'));
				assert.ok(failure);
				assert.match(failure.reason, /乱序/);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it('超过 32MB 的声明直接拒绝', () => {
			const store = new TabAttachmentStore(makeTempRoot());
			const failure = store.prepare('tab-a', {
				attachmentId: 'att-3',
				fileName: 'big.bin',
				mediaType: '',
				size: MAX_ATTACHMENT_BYTES + 1,
			});
			assert.ok(failure);
			assert.match(failure.reason, /32MB/);
		});

		it('附件 id 不能带路径穿越，文件名只取 basename', () => {
			const store = new TabAttachmentStore(makeTempRoot());
			const failure = store.prepare('tab-a', {
				attachmentId: '../escape',
				fileName: 'x.txt',
				mediaType: '',
				size: 1,
			});
			assert.ok(failure, 'attachmentId 是路径的一部分，必须白名单校验');
			assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
			assert.strictEqual(sanitizeFileName('C:\\tmp\\a b.txt'), 'a b.txt');
		});

		it('releaseTab 清掉该 tab 的临时文件', () => {
			const root = makeTempRoot();
			try {
				const store = new TabAttachmentStore(root);
				store.prepare('tab-a', { attachmentId: 'att-4', fileName: 'n.txt', mediaType: '', size: 3 });
				store.chunk('tab-a', 'att-4', 0, Buffer.from('abc').toString('base64'));
				store.complete('tab-a', 'att-4');
				const file = store.resolve('tab-a', 'att-4')!.path;
				assert.ok(existsSync(file));

				store.releaseTab('tab-a');
				assert.strictEqual(existsSync(file), false);
				assert.deepStrictEqual(existsSync(join(root, 'tab-a')) ? readdirSync(join(root, 'tab-a')) : [], []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it('目录不可用时 prepare 明确失败（不静默丢附件）', () => {
			const store = new TabAttachmentStore(null);
			const failure = store.prepare('tab-a', { attachmentId: 'a', fileName: 'a', mediaType: '', size: 1 });
			assert.ok(failure);
			assert.match(failure.reason, /不可用/);
		});
	});

	describe('ChatWindow 接线', () => {
		const sent: SendMessagePayload[] = [];
		const sessions: OpenCodeSession[] = [];
		let root = '';

		const makeChatWindow = (): ChatWindow => new ChatWindow({
			settings: {} as never,
			daemon: {} as never,
			fileOps: {} as never,
			fallbackWorkingDirectoryResolver: () => '/mock/workspace',
			attachmentsRoot: root,
			createSession: (sink: JsTarget) => {
				const state = new SessionState();
				const adapter = new SessionCallbackAdapter({ jsTarget: sink, model: () => state.getModel() });
				const session = {
					state,
					getState: () => state,
					getAdapter: () => adapter,
					setCallback: () => {},
					send: async (payload: SendMessagePayload) => {
						sent.push(payload);
					},
					sendShell: async () => {},
					interrupt: () => {},
					dispose: () => {},
				} as unknown as OpenCodeSession;
				sessions.push(session);
				return session;
			},
		});

		const run = async (
			chatWindow: ChatWindow,
			viewId: string,
			type: string,
			tabId: string,
			payload: Record<string, unknown>,
		): Promise<void> => {
			await chatWindow.handleViewCommand(viewId, {
				v: 2,
				type,
				requestId: `${type}-${Math.random().toString(36).slice(2)}`,
				tabId,
				sessionId: null,
				payload,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		};

		beforeEach(() => {
			root = makeTempRoot();
			sent.length = 0;
			sessions.length = 0;
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it('发送时把 attachmentId 补成内联字节', async () => {
			const chatWindow = makeChatWindow();
			chatWindow.registerView('sidebar', new MockChannel());
			const tabA = chatWindow.registry.getActiveTabId()!;
			const base64 = Buffer.from('hello').toString('base64');

			await run(chatWindow, 'sidebar', 'attachment.prepare', tabA.value, {
				attachmentId: 'att-x',
				fileName: 'note.txt',
				mediaType: 'text/plain',
				size: 5,
			});
			await run(chatWindow, 'sidebar', 'attachment.chunk', tabA.value, {
				attachmentId: 'att-x',
				offset: 0,
				data: base64,
			});
			await run(chatWindow, 'sidebar', 'attachment.complete', tabA.value, { attachmentId: 'att-x' });
			await run(chatWindow, 'sidebar', 'session.send', tabA.value, {
				text: 'see attached',
				attachments: [{ attachmentId: 'att-x', fileName: 'note.txt', mediaType: 'text/plain' }],
			});

			assert.strictEqual(sent.length, 1);
			const attachment = sent[0].attachments?.[0];
			assert.strictEqual(attachment?.data, base64);
			assert.strictEqual(attachment?.fileName, 'note.txt');
		});

		it('附件读不出来时整条消息不发，并给出提示', async () => {
			const chatWindow = makeChatWindow();
			const view = new MockChannel();
			chatWindow.registerView('sidebar', view);
			const tabA = chatWindow.registry.getActiveTabId()!;

			await run(chatWindow, 'sidebar', 'session.send', tabA.value, {
				text: 'see attached',
				attachments: [{ attachmentId: 'missing', fileName: 'gone.png' }],
			});

			assert.strictEqual(sent.length, 0, '缺附件不能发出去');
			const error = view.calls.find((c) => c.fn === 'addErrorMessage');
			assert.ok(error, '必须提示用户');
			assert.match(error.args[0], /附件不可用/);
		});

		it('关 tab 时释放该 tab 的附件目录', async () => {
			const chatWindow = makeChatWindow();
			chatWindow.registerView('sidebar', new MockChannel());
			const tabA = chatWindow.registry.getActiveTabId()!;
			const base64 = Buffer.from('abc').toString('base64');

			await run(chatWindow, 'sidebar', 'attachment.prepare', tabA.value, {
				attachmentId: 'att-y', fileName: 'n.txt', mediaType: '', size: 3,
			});
			await run(chatWindow, 'sidebar', 'attachment.chunk', tabA.value, {
				attachmentId: 'att-y', offset: 0, data: base64,
			});
			await run(chatWindow, 'sidebar', 'attachment.complete', tabA.value, { attachmentId: 'att-y' });
			const file = chatWindow.attachments.resolve(tabA.value, 'att-y')!.path;
			assert.ok(existsSync(file));

			await run(chatWindow, 'sidebar', 'tab.close', tabA.value, {});
			assert.strictEqual(existsSync(file), false);
		});
	});
});
