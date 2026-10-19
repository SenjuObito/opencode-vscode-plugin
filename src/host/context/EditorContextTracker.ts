/**
 * EditorContextTracker — port of cc-gui `ui/EditorContextTracker.java`.
 * Tracks the active editor file + selection and pushes it to the webview
 * ContextBar via `window.addSelectionInfo('@path#L1-L2')` /
 * `window.clearSelectionInfo()`（200ms 防抖，与 IDE 版一致）。
 *
 * 注意：这里**不**读取「发送打开的文件路径」设置。
 * 该设置只决定新会话 / 历史会话加载时 tab 的初始开关状态；tab 内是否展示、
 * 发送时是否注入，都由前端按 tab 状态（send payload 的 autoOpenFileEnabled）
 * 决定。宿主始终跟踪当前编辑器并广播，前端自行忽略即可。
 */
import * as vscode from 'vscode';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';

const DEBOUNCE_MS = 200;

export class EditorContextTracker {
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly disposables: vscode.Disposable[] = [];
	/** 最近一次计算的上下文（'@path#L1-L2' 或 null），供发送时注入。 */
	private lastInfo: string | null = null;

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
		// 编辑器打开 / 关闭（关闭最后一个文件后需要清空上下文）
		this.disposables.push(
			vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleUpdate()),
		);
		this.updateNow();
	}

	/** 立即计算并广播当前上下文（webview 面板就绪、编辑器事件触发时调用）。 */
	updateNow(): void {
		if (this.disposed) {
			return;
		}
		const info = this.resolveInfo();
		this.lastInfo = info;
		if (info) {
			WebviewBroadcaster.broadcastJavaScript('addSelectionInfo', info);
		} else {
			WebviewBroadcaster.broadcastJavaScript('clearSelectionInfo');
		}
	}

	/**
	 * 只把当前上下文推送给单个 webview（tab 切换 / tab 内打开文件上下文时调用）。
	 * 推送目标由调用方通过 `emit` 决定，避免影响其他分栏。
	 */
	pushTo(emit: (info: string | null) => void): void {
		if (this.disposed) {
			emit(null);
			return;
		}
		const info = this.resolveInfo();
		this.lastInfo = info;
		emit(info);
	}

	/**
	 * 解析当前编辑器上下文：
	 * - 优先 activeTextEditor；
	 * - 焦点在 webview 时 activeTextEditor 为 undefined，回退到可见的文件编辑器
	 *   （分栏仍显示，因此不会误清空）；
	 * - 没有任何可见文件编辑器时返回 null（关闭全部文件 → 清空）。
	 */
	private resolveInfo(): string | null {
		try {
			let editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.scheme !== 'file') {
				editor = vscode.window.visibleTextEditors.find(
					(e) => e.document.uri.scheme === 'file',
				);
			}
			if (!editor) {
				return null;
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
			return info;
		} catch (err) {
			console.warn(`[EditorContextTracker] resolve failed: ${String(err)}`);
			return this.lastInfo;
		}
	}

	/** 清空上下文缓存并通知所有 webview。 */
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
