/**
 * EditorContextTracker — port of cc-gui `ui/EditorContextTracker.java`.
 * Tracks the active editor file + selection and pushes it to the webview
 * ContextBar via `window.addSelectionInfo('@path#L1-L2')` /
 * `window.clearSelectionInfo()`（200ms 防抖，与 IDE 版一致）。
 */
import * as vscode from 'vscode';
import type { HandlerContext } from '../router/HandlerContext';

const DEBOUNCE_MS = 200;

export class EditorContextTracker {
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly disposables: vscode.Disposable[] = [];
	/** 最近一次计算的上下文（'@path#L1-L2' 或 null），供发送时注入。 */
	private lastInfo: string | null = null;

	constructor(private readonly context: HandlerContext) {}

	/** 当前编辑器上下文（cc-gui EditorContextCollector.collectContext 等价物）。 */
	getCurrentSelectionInfo(): string | null {
		return this.disposed ? null : this.lastInfo;
	}

	register(): void {
		// 文件切换
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
		);
		// 选区变化
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(() => this.scheduleUpdate()),
		);
	}

	/** 立即推送当前上下文（webview 面板就绪时调用）。 */
	updateNow(): void {
		if (this.disposed) {
			return;
		}
		try {
			// 与 cc-gui 一致：关闭「自动打开文件」设置时清空 ContextBar。
			const projectPath = this.context.getSettingsService().getPrimaryWorkspaceRoot();
			if (projectPath && !this.context.getSettingsService().getAutoOpenFileEnabled(projectPath)) {
				this.clear();
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.scheme !== 'file') {
				this.clear();
				return;
			}

			let info = `@${editor.document.uri.fsPath}`;
			const selection = editor.selection;
			if (!selection.isEmpty) {
				const startLine = selection.start.line + 1;
				let endLine = selection.end.line + 1;
				// 末行选中到行首时视为不包含该行（与 Java 版 offsetToLogicalPosition 判断等价）
				if (endLine > startLine && selection.end.character === 0) {
					endLine--;
				}
				info += `#L${startLine}-${endLine}`;
			}

			this.lastInfo = info;
			this.context.callJavaScript('addSelectionInfo', info);
		} catch (err) {
			console.warn(`[EditorContextTracker] update failed: ${String(err)}`);
		}
	}

	/** 清空上下文缓存并通知 webview（autoOpenFile 关闭等场景需同步调用）。 */
	clear(): void {
		this.lastInfo = null;
		this.context.callJavaScript('clearSelectionInfo');
	}

	private scheduleUpdate(): void {
		if (this.disposed) {
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.updateNow();
		}, DEBOUNCE_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}
