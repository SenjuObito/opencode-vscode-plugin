/**
 * ExportHandler — handles session export requests (e.g. export to Markdown).
 * Reuses OpenCode daemon session messages and format them as Markdown.
 */
import * as vscode from 'vscode';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { SessionMarkdownFormatter, ExportSessionMetadata } from '../export/SessionMarkdownFormatter';
import { logError } from '../util/DiagnosticLogger';

const SUPPORTED_TYPES = [
	'export_session',
	'export_session_markdown',
];

export class ExportHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (type === 'export_session' || type === 'export_session_markdown') {
			void this.handleExportSession(content);
			return true;
		}
		return false;
	}

	private async handleExportSession(content: string): Promise<void> {
		let sessionId = '';
		let title = '';
		let mode: 'save' | 'open' | 'copy' = 'save';

		try {
			const parsed = JSON.parse(content || '{}') as Record<string, unknown>;
			sessionId = String(parsed.sessionId || '');
			title = String(parsed.title || '');
			if (parsed.mode === 'open' || parsed.mode === 'copy') {
				mode = parsed.mode;
			}
		} catch {
			sessionId = (content || '').trim();
		}

		if (!sessionId) {
			const activeSession = this.context.getSession();
			sessionId = activeSession?.state.getSessionId() || '';
		}

		if (!sessionId) {
			void vscode.window.showErrorMessage('无法导出会话：未指定会话 ID');
			return;
		}

		const daemon = this.context.getDaemon();
		if (!daemon) {
			void vscode.window.showErrorMessage('无法导出会话：OpenCode daemon 未启动');
			return;
		}

		try {
			const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
			const collector = new ListMessagesCollector();

			// 1. 从 daemon 获取会话的所有消息
			await new Promise<void>((resolve, reject) => {
				const ok = daemon.request('opencode.listMessages', { sessionId, directory }, {
					onLine: (line) => collector.onLine(line),
					onError: (err) => reject(new Error(typeof err === 'string' ? err : 'listMessages failed')),
					onComplete: (success) => {
						if (success) {
							resolve();
						} else {
							collector.reconcileFallback();
							resolve();
						}
					},
				});
				if (!ok) {
					reject(new Error('Daemon request opencode.listMessages failed to send'));
				}
			});

			const entries = collector.getEntries();
			const meta: ExportSessionMetadata = {
				id: sessionId,
				title: title || 'Session',
				createdAt: Date.now(),
			};

			// 2. 格式化为 Markdown
			const markdownContent = SessionMarkdownFormatter.format(meta, entries);

			// 3. 根据 mode 处理输出
			if (mode === 'copy') {
				await vscode.env.clipboard.writeText(markdownContent);
				void vscode.window.showInformationMessage('会话 Markdown 已复制到剪贴板');
				return;
			}

			if (mode === 'open') {
				const doc = await vscode.workspace.openTextDocument({
					content: markdownContent,
					language: 'markdown',
				});
				await vscode.window.showTextDocument(doc, { preview: false });
				return;
			}

			// 默认 mode === 'save': 弹出保存对话框
			const sanitizedTitle = (title || `session_${sessionId.slice(0, 8)}`)
				.replace(/[/\\?%*:|"<>]/g, '_')
				.replace(/\s+/g, '_')
				.slice(0, 50);
			const defaultFileName = `${sanitizedTitle}.md`;

			const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
				? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
				: vscode.Uri.file(defaultFileName);

			const fileUri = await vscode.window.showSaveDialog({
				defaultUri,
				filters: {
					Markdown: ['md'],
					'All Files': ['*'],
				},
				title: '导出会话为 Markdown',
			});

			if (!fileUri) {
				// 用户取消保存
				return;
			}

			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdownContent, 'utf-8'));
			const action = await vscode.window.showInformationMessage(
				`会话已成功导出为 Markdown: ${fileUri.fsPath.split(/[/\\]/).pop()}`,
				'打开文件',
			);
			if (action === '打开文件') {
				const doc = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(doc);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			logError(`[ExportHandler] 导出会话失败: ${errorMsg}`);
			void vscode.window.showErrorMessage(`导出会话失败: ${errorMsg}`);
		}
	}
}
