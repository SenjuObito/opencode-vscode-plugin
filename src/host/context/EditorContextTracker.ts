/**
 * EditorContextTracker — port of cc-gui `ui/EditorContextTracker.java`.
 * Tracks the active editor file + selection and pushes it to the webview
 * ContextBar via `window.addSelectionInfo('@path#L1-L2')` /
 * `window.clearSelectionInfo()`（200ms 防抖，与 IDE 版一致）。
 */
import * as vscode from 'vscode';
import type { SettingsService } from '../settings/SettingsService';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';

const DEBOUNCE_MS = 200;

export class EditorContextTracker {
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly disposables: vscode.Disposable[] = [];
	/** 最近一次计算的上下文（'@path#L1-L2' 或 null），供发送时注入。 */
	private lastInfo: string | null = null;

	constructor(private readonly settings: SettingsService) {}

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
		this.updateNow();
	}

	/** 立即推送当前上下文（webview 面板就绪时调用）。 */
	updateNow(): void {
		if (this.disposed) {
			return;
		}
		try {
			// 与 cc-gui 一致：关闭「自动打开文件」设置时清空 ContextBar。
			const projectPath = this.settings.getPrimaryWorkspaceRoot();
			if (projectPath && !this.settings.getAutoOpenFileEnabled(projectPath)) {
				this.clear();
				return;
			}

			// 优先获取 activeTextEditor；如果当前焦点在 webview（activeTextEditor 为 undefined），
			// 尝试从 visibleTextEditors 中寻找可见的文件编辑器；若都不可见但已有 lastInfo 则保持，否则才清空。
			let editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.scheme !== 'file') {
				const visibleFileEditor = vscode.window.visibleTextEditors.find(
					(e) => e.document.uri.scheme === 'file',
				);
				if (visibleFileEditor) {
					editor = visibleFileEditor;
				} else if (this.lastInfo) {
					// 焦点临时切至 WebviewPanel 且分栏无可见编辑器时，广播保持最近一次选中的有效文件上下文
					WebviewBroadcaster.broadcastJavaScript('addSelectionInfo', this.lastInfo);
					return;
				} else {
					this.clear();
					return;
				}
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
			WebviewBroadcaster.broadcastJavaScript('addSelectionInfo', info);
		} catch (err) {
			console.warn(`[EditorContextTracker] update failed: ${String(err)}`);
		}
	}

	/** 清空上下文缓存并通知 webview（autoOpenFile 关闭等场景需同步调用）。 */
	clear(): void {
		this.lastInfo = null;
		WebviewBroadcaster.broadcastJavaScript('clearSelectionInfo');
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
