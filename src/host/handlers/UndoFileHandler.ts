/**
 * UndoFileHandler — port of cc-gui `handler/file/UndoFileHandler.java`.
 *
 * Reverts AI-made file edits reported by the webview Edits panel:
 *   undo_file_changes      → { filePath, status('A'|'M'), operations[] }
 *   undo_all_file_changes  → { files: [同上结构] }
 *
 * status='A'（AI 新建的文件）→ 直接删除；status='M' → 逆序把每段
 * newString 还原为 oldString。结果经 window.onUndoFileResult /
 * onUndoAllFileResult 回推（webview 已注册回调）。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['undo_file_changes', 'undo_all_file_changes'];

interface EditOperationInput {
	oldString?: string;
	newString?: string;
	replaceAll?: boolean;
	/** apply_patch 删除文件标记（无法凭文本还原） */
	kind?: string;
}

interface FileChangeInput {
	filePath?: string;
	status?: string;
	operations?: EditOperationInput[];
}

export class UndoFileHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'undo_file_changes':
				void this.handleUndoFileChanges(content);
				return true;
			case 'undo_all_file_changes':
				void this.handleUndoAllFileChanges(content);
				return true;
			default:
				return false;
		}
	}

	// ── undo_file_changes ──────────────────────────────────────────────────

	private async handleUndoFileChanges(content: string): Promise<void> {
		let req: FileChangeInput;
		try {
			req = JSON.parse(content) as FileChangeInput;
		} catch (ex) {
			this.sendError('', `Invalid request: ${String(ex)}`);
			return;
		}

		const filePath = typeof req?.filePath === 'string' ? req.filePath : '';
		const status = typeof req?.status === 'string' ? req.status : '';
		const operations = Array.isArray(req?.operations) ? req.operations : [];

		if (!filePath) {
			this.sendError('', 'File path is required');
			return;
		}
		const absPath = this.resolveAbsolutePath(filePath);
		if (!this.isPathInWorkspace(absPath)) {
			this.sendError(filePath, 'Invalid file path: path must be within workspace');
			return;
		}
		if (!status) {
			this.sendError(filePath, 'File status is required');
			return;
		}

		try {
			if (status === 'A') {
				await this.deleteAddedFile(absPath);
			} else if (status === 'M') {
				if (operations.length === 0) {
					this.sendError(filePath, 'No operations to undo');
					return;
				}
				await this.reverseEdits(absPath, operations);
			} else if (status === 'D') {
				this.sendError(filePath, 'Cannot restore a file that was deleted by AI');
				return;
			} else {
				this.sendError(filePath, `Unknown file status: ${status}`);
				return;
			}
			this.sendSuccess(filePath);
		} catch (ex) {
			const message = ex instanceof Error ? ex.message : String(ex);
			console.warn(`[UndoFileHandler] undo failed for ${filePath}: ${message}`);
			this.sendError(filePath, message);
		}
	}

	// ── undo_all_file_changes ──────────────────────────────────────────────

	private async handleUndoAllFileChanges(content: string): Promise<void> {
		let req: { files?: FileChangeInput[] };
		try {
			req = JSON.parse(content) as { files?: FileChangeInput[] };
		} catch (ex) {
			this.sendAllError(`Invalid request: ${String(ex)}`);
			return;
		}

		const files = Array.isArray(req?.files) ? req.files : [];
		if (files.length === 0) {
			this.sendAllError('No files to undo');
			return;
		}

		// 如实回报：逐文件记录成败，部分失败时 webview 只移除已成功的文件。
		const undone: string[] = [];
		const failed: Array<{ filePath: string; error: string }> = [];
		for (const file of files) {
			const rawPath = typeof file?.filePath === 'string' ? file.filePath : '';
			const status = typeof file?.status === 'string' ? file.status : '';
			const operations = Array.isArray(file?.operations) ? file.operations : [];
			try {
				if (!rawPath) {
					failed.push({ filePath: '', error: 'Missing file path' });
					continue;
				}
				const absPath = this.resolveAbsolutePath(rawPath);
				if (!this.isPathInWorkspace(absPath)) {
					failed.push({ filePath: rawPath, error: 'Path must be within workspace' });
					continue;
				}
				if (status === 'A') {
					await this.deleteAddedFile(absPath);
				} else if (status === 'M' && operations.length > 0) {
					await this.reverseEdits(absPath, operations);
				} else if (status === 'D') {
					failed.push({ filePath: rawPath, error: 'Cannot restore a file deleted by AI' });
					continue;
				}
				undone.push(rawPath);
			} catch (ex) {
				const message = ex instanceof Error ? ex.message : String(ex);
				console.warn(`[UndoFileHandler] batch undo failed for ${rawPath}: ${message}`);
				failed.push({ filePath: rawPath, error: message });
			}
		}
		this.callJavaScript('onUndoAllFileResult', JSON.stringify({
			success: failed.length === 0,
			total: files.length,
			undone,
			failed,
		}));
	}

	// ── helpers ────────────────────────────────────────────────────────────

	/**
	 * 解析为绝对路径：apply_patch 的补丁头里是相对 worktree 的路径，
	 * 相对路径按会话工作目录拼接。
	 */
	private resolveAbsolutePath(rawPath: string): string {
		if (path.isAbsolute(rawPath)) {
			return rawPath;
		}
		const base = this.context.resolveEffectiveWorkingDirectory();
		return base ? path.join(base, rawPath) : rawPath;
	}

	/** 路径必须位于某个 workspace folder 内（cc-gui 同款安全校验）。 */
	private isPathInWorkspace(fsPath: string): boolean {
		try {
			return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath)) !== undefined;
		} catch {
			return false;
		}
	}

	/** 删除 AI 新建的文件；文件已不存在视为成功。 */
	private async deleteAddedFile(fsPath: string): Promise<void> {
		const uri = vscode.Uri.file(fsPath);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			return; // already gone
		}
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	}

	/**
	 * 逆序反向应用编辑操作：newString → oldString。
	 * 找不到目标文本的操作跳过并告警（与 cc-gui 一致，避免整体失败）。
	 */
	private async reverseEdits(fsPath: string, operations: EditOperationInput[]): Promise<void> {
		const uri = vscode.Uri.file(fsPath);
		const raw = await vscode.workspace.fs.readFile(uri);
		let content = Buffer.from(raw).toString('utf8');

		for (let i = operations.length - 1; i >= 0; i--) {
			const op = operations[i] ?? {};
			const oldString = typeof op.oldString === 'string' ? op.oldString : '';
			const newString = typeof op.newString === 'string' ? op.newString : '';
			// newString 为空意味着该操作原本是删除内容，无法凭文本定位还原，跳过。
			if (newString === '') {
				continue;
			}
			if (op.replaceAll) {
				content = content.split(newString).join(oldString);
			} else {
				const index = content.indexOf(newString);
				if (index >= 0) {
					content = content.substring(0, index) + oldString + content.substring(index + newString.length);
				} else {
					console.warn(
						`[UndoFileHandler] Could not find newString to replace: ${newString.substring(0, 50)}...`,
					);
				}
			}
		}

		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
	}

	// ── callbacks ──────────────────────────────────────────────────────────

	private sendSuccess(filePath: string): void {
		this.callJavaScript('onUndoFileResult', JSON.stringify({ success: true, filePath }));
	}

	private sendError(filePath: string, error: string): void {
		this.callJavaScript(
			'onUndoFileResult',
			JSON.stringify({ success: false, filePath: filePath ?? '', error }),
		);
	}

	private sendAllError(error: string): void {
		this.callJavaScript('onUndoAllFileResult', JSON.stringify({ success: false, error }));
	}
}
