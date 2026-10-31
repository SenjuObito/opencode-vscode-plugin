import './mockVscode';
import * as assert from 'assert';
import { FileHandler, normalizeRelativePath } from '../host/handlers/FileHandler';
import { HandlerContext, type WebviewChannel } from '../host/router/HandlerContext';

/**
 * Regression tests for the @-mention file source.
 *
 * The dropdown used to be populated from `opencode.findFiles` only, and the
 * local collector ran *solely* when the daemon threw. `fs.find("")` answers
 * `[]` (it is a fuzzy search), so typing `@` produced no files at all while
 * `@e` worked. These cases pin the API-only contract:
 *
 *  - empty query / `@dir/` → `opencode.listFiles` (`/api/fs/list`)
 *  - non-empty query       → `opencode.findFiles` with the directory prefix
 *  - failure               → `[]` (no local fallback pretending to succeed)
 */

class MockChannel implements WebviewChannel {
	public calls: Array<{ fn: string; args: string[] }> = [];

	public callJavaScript(functionName: string, ...args: string[]): void {
		this.calls.push({ fn: functionName, args });
	}

	public isDisposed(): boolean {
		return false;
	}

	public postRaw(): void {
		// no-op
	}
}

interface DaemonCall {
	command: string;
	params: Record<string, unknown>;
}

function makeHandler(
	response: string | Error,
	calls: DaemonCall[] = [],
): FileHandler {
	const channel = new MockChannel();
	const context = new HandlerContext(channel, {} as never);
	const daemon = {
		request: (
			command: string,
			params: Record<string, unknown>,
			callbacks: {
				onLine?: (line: string) => void;
				onStderr?: (text: string) => void;
				onError?: (error: string) => void;
				onComplete?: (ok: boolean) => void;
			},
		): Promise<void> => {
			calls.push({ command, params });
			if (response instanceof Error) {
				callbacks.onError?.(response.message);
				return Promise.resolve();
			}
			callbacks.onLine?.(response);
			callbacks.onComplete?.(true);
			return Promise.resolve();
		},
	};
	context.setDaemon(daemon as never);
	return new FileHandler(context);
}

function entriesLine(entries: Array<{ path: string; type?: string }>): string {
	return JSON.stringify({ success: true, provider: 'opencode', entries });
}

suite('FileHandler.listFiles —— @ 候选只走 opencode API', () => {
	test('空 query 走 fs.list（不是 fs.find）', async () => {
		const calls: DaemonCall[] = [];
		const handler = makeHandler(
			entriesLine([{ path: '.github\\', type: 'directory' }, { path: 'README.md', type: 'file' }]),
			calls,
		);

		const files = await handler.listFiles('', '', '/repo');

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].command, 'opencode.listFiles');
		assert.strictEqual(calls[0].params.path, '');
		assert.strictEqual(calls[0].params.directory, '/repo');
		assert.deepStrictEqual(files.map((f) => f.path), ['.github', 'README.md']);
		assert.strictEqual(files[0].type, 'directory');
	});

	test('@src/ 走 fs.list 且 path=src', async () => {
		const calls: DaemonCall[] = [];
		const handler = makeHandler(entriesLine([{ path: 'src\\host\\', type: 'directory' }]), calls);

		const files = await handler.listFiles('', 'src/', '/repo');

		assert.strictEqual(calls[0].command, 'opencode.listFiles');
		assert.strictEqual(calls[0].params.path, 'src');
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].path, 'src/host', '目录尾分隔符必须被剥掉');
		assert.strictEqual(files[0].name, 'host');
		// 绝对路径由 path.join 拼出，断言前统一分隔符（测试跨平台）。
		assert.strictEqual(files[0].absolutePath.replace(/\\/g, '/'), '/repo/src/host');
	});

	test('@src/ho 把目录前缀拼进 fs.find 的 query', async () => {
		const calls: DaemonCall[] = [];
		const handler = makeHandler(entriesLine([{ path: 'src/host/window/ChatWindow.ts', type: 'file' }]), calls);

		const files = await handler.listFiles('ho', 'src/', '/repo');

		assert.strictEqual(calls[0].command, 'opencode.findFiles');
		assert.strictEqual(calls[0].params.query, 'src/ho');
		assert.strictEqual(calls[0].params.directory, '/repo');
		assert.strictEqual(files[0].extension, 'ts');
	});

	test('daemon 失败时回空列表，不回退本地扫描', async () => {
		const handler = makeHandler(new Error('daemon down'));

		const files = await handler.listFiles('', '', '/repo');
		assert.deepStrictEqual(files, []);

		const searched = await handler.listFiles('x', '', '/repo');
		assert.deepStrictEqual(searched, []);
	});

	test('normalizeRelativePath 收敛各种输入，并挡住越界路径', () => {
		assert.strictEqual(normalizeRelativePath(''), '');
		assert.strictEqual(normalizeRelativePath('src/'), 'src');
		assert.strictEqual(normalizeRelativePath('./src/'), 'src');
		assert.strictEqual(normalizeRelativePath('src\\host\\'), 'src/host');
		assert.strictEqual(normalizeRelativePath('../../etc'), '');
		assert.strictEqual(normalizeRelativePath('/abs/path'), '');
		assert.strictEqual(normalizeRelativePath('C:\\Windows'), '');
	});
});
