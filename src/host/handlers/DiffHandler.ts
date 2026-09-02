/**
 * DiffHandler — port of cc-gui diff handlers（EditableDiffHandler /
 * SimpleDiffDisplayHandler）的 VS Code 版。
 *
 *   show_editable_diff → Edits 面板「diff」按钮：左侧虚拟文档为 AI 编辑前
 *                         的原文，右侧为真实文件（可继续编辑）。
 *   show_diff          → 聊天流 Edit 工具块：oldContent ↔ newContent 只读对比。
 *
 * 虚拟文档通过 TextDocumentContentProvider 提供（scheme `opencode-diff:`），
 * 内容存内存 Map。provider 为模块级单例——本 handler 会在 extension 与
 * ChatInstance 两处装配点各注册一次 dispatcher。
 */
import * as vscode from 'vscode';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['show_editable_diff', 'show_diff'];
const SCHEME = 'opencode-diff';

interface DiffOperationInput {
	oldString?: string;
	newString?: string;
	replaceAll?: boolean;
}

/** 模块级单例 content provider（重复 register 会抛异常）。 */
let sharedProvider: vscode.TextDocumentContentProvider | null = null;
let providerDisposable: vscode.Disposable | null = null;
const virtualContents = new Map<string, string>();

function ensureProviderRegistered(): vscode.Disposable {
	if (providerDisposable) {
		// 已注册：返回空 Disposable，避免重复注册抛异常。
		return new vscode.Disposable(() => {});
	}
	sharedProvider = {
		provideTextDocumentContent(uri: vscode.Uri): string {
			// uri.path = /<id>/<basename>；按 id 取内容
			const id = uri.path.split('/')[1] ?? '';
			return virtualContents.get(id) ?? '';
		},
	};
	providerDisposable = vscode.workspace.registerTextDocumentContentProvider(SCHEME, sharedProvider);
	return providerDisposable;
}

function createVirtualUri(content: string, basename: string): vscode.Uri {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	virtualContents.set(id, content);
	return vscode.Uri.parse(`${SCHEME}:/${id}/${basename}`);
}

export class DiffHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
		ensureProviderRegistered();
	}

	/** 释放 content provider 注册（extension.ts 订阅；幂等）。 */
	dispose(): void {
		if (providerDisposable) {
			providerDisposable.dispose();
			providerDisposable = null;
		}
		virtualContents.clear();
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'show_editable_diff':
				void this.handleShowEditableDiff(content);
				return true;
			case 'show_diff':
				void this.handleShowDiff(content);
				return true;
			default:
				return false;
		}
	}

	// ── show_editable_diff ─────────────────────────────────────────────────

	/** { filePath, operations[{oldString,newString,replaceAll}], status } */
	private async handleShowEditableDiff(content: string): Promise<void> {
		try {
			const req = JSON.parse(content) as {
				filePath?: string;
				status?: string;
				operations?: DiffOperationInput[];
			};
			const filePath = typeof req?.filePath === 'string' ? req.filePath : '';
			const operations = Array.isArray(req?.operations) ? req.operations : [];
			if (!filePath || operations.length === 0) {
				return;
			}

			const fileUri = vscode.Uri.file(filePath);
			const raw = await vscode.workspace.fs.readFile(fileUri);
			const current = Buffer.from(raw).toString('utf8');

			// 反向应用全部操作得到编辑前原文（算法与 UndoFileHandler 一致）。
			let original = current;
			for (let i = operations.length - 1; i >= 0; i--) {
				const op = operations[i] ?? {};
				const oldString = typeof op.oldString === 'string' ? op.oldString : '';
				const newString = typeof op.newString === 'string' ? op.newString : '';
				if (newString === '') {
					continue;
				}
				if (op.replaceAll) {
					original = original.split(newString).join(oldString);
				} else {
					const index = original.indexOf(newString);
					if (index >= 0) {
						original =
							original.substring(0, index) +
							oldString +
							original.substring(index + newString.length);
					}
				}
			}

			const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
			const originalUri = createVirtualUri(original, fileName);
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				fileUri,
				`${fileName} (Original ↔ Current)`,
				{ preview: false },
			);
		} catch (ex) {
			const message = ex instanceof Error ? ex.message : String(ex);
			this.context.callJavaScript('showError', `Failed to open diff: ${message}`);
		}
	}

	// ── show_diff ──────────────────────────────────────────────────────────

	/** { filePath, oldContent, newContent, title } — 只读双栏对比。 */
	private async handleShowDiff(content: string): Promise<void> {
		try {
			const req = JSON.parse(content) as {
				filePath?: string;
				oldContent?: string;
				newContent?: string;
				title?: string;
			};
			const oldContent = typeof req?.oldContent === 'string' ? req.oldContent : '';
			const newContent = typeof req?.newContent === 'string' ? req.newContent : '';
			const filePath = typeof req?.filePath === 'string' ? req.filePath : '';
			const title = typeof req?.title === 'string' && req.title ? req.title : 'Diff';

			let rightUri: vscode.Uri;
			if (filePath) {
				rightUri = vscode.Uri.file(filePath);
			} else {
				rightUri = createVirtualUri(newContent, 'new');
			}
			const leftUri = createVirtualUri(oldContent, filePath.split(/[\\/]/).pop() ?? 'original');

			await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
				preview: false,
			});
		} catch (ex) {
			const message = ex instanceof Error ? ex.message : String(ex);
			this.context.callJavaScript('showError', `Failed to open diff: ${message}`);
		}
	}
}
