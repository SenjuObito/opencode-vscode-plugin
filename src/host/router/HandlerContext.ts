/**
 * HandlerContext — port of cc-gui `handler/core/HandlerContext.java`.
 * Provides shared resources for message handlers: the webview channel,
 * the current session, model/provider, and settings.
 */
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SessionManager } from '../session/SessionManager';
import type { SettingsService } from '../settings/SettingsService';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';

/** Webview 桥：向 `window.<fn>` 推消息。 */
export interface WebviewChannel {
	callJavaScript(functionName: string, ...args: string[]): void;
	isDisposed(): boolean;
	postRaw(message: unknown): void;
	/**
	 * 当前存活 webview 数量（可选）。
	 * 侧边栏左/右视图与编辑器分栏窗口共享同一会话，视图就绪时需要据此
	 * 判断「当前会话是否还有别的视图在展示」——有则补推快照，没有则清成新会话。
	 * 未实现时按单视图处理。
	 */
	getViewCount?(): number;
}

/** 宿主注入的文件操作（VS Code 用 workspace.fs / 编辑器打开）。 */
export interface FileOps {
	openFile(path: string): void;
	resolveFilePath(path: string | null): string | null;
	/** 用系统浏览器打开外部 URL（vscode.env.openExternal）。 */
	openExternal(url: string): void;
	/**
	 * 用宿主侧剪贴板写入文本（vscode.env.clipboard）。
	 * webview 内 navigator.clipboard / execCommand 受权限策略限制不可靠，
	 * 分享链接等关键复制必须走这条通道。返回是否成功。
	 */
	copyToClipboard(text: string): boolean;
}

export class HandlerContext {
	private sessionManager: SessionManager | null = null;
	private session: OpenCodeSession | null = null;
	private currentModel: string | null = null;
	private currentProvider = 'opencode';
	private disposed = false;
	private fallbackWorkingDir: (() => string | null) | null = null;
	private daemon: OpenCodeDaemonBridge | null = null;
	private fileOps: FileOps = {
		openFile: () => {},
		resolveFilePath: (p) => p,
		openExternal: () => {},
		copyToClipboard: () => false,
	};

	constructor(
		private readonly channel: WebviewChannel,
		private readonly settings: SettingsService,
	) {}

	/** 常驻 opencode daemon（serve + SDK）。由宿主在装配时注入。 */
	getDaemon(): OpenCodeDaemonBridge | null {
		return this.daemon;
	}

	setDaemon(daemon: OpenCodeDaemonBridge | null): void {
		this.daemon = daemon;
	}

	getFileOps(): FileOps {
		return this.fileOps;
	}

	setFileOps(fileOps: FileOps): void {
		this.fileOps = fileOps;
	}

	/** 由宿主注入：workspace 之外的工作目录解析（默认取活跃编辑器父目录）。 */
	setFallbackWorkingDirectoryResolver(resolver: (() => string | null) | null): void {
		this.fallbackWorkingDir = resolver;
	}

	/** 宿主注入的编辑器上下文清除钩子（EditorContextTracker.clear）。 */
	private editorContextClearer: (() => void) | null = null;

	setEditorContextClearer(clear: (() => void) | null): void {
		this.editorContextClearer = clear;
	}

	/** 立即清空编辑器上下文缓存并通知 webview（设置关闭时同步调用，避免发送读到过期缓存）。 */
	clearEditorContext(): void {
		this.editorContextClearer?.();
	}

	/** 宿主注入的编辑器上下文推送钩子（EditorContextTracker.updateNow）。 */
	private editorContextPusher: (() => void) | null = null;

	setEditorContextPusher(pusher: (() => void) | null): void {
		this.editorContextPusher = pusher;
	}

	/** 立即推送当前编辑器上下文到 webview（frontend_ready 等时机调用）。 */
	pushEditorContext(): void {
		this.editorContextPusher?.();
	}

	/**
	 * 宿主注入的编辑器上下文刷新钩子：只作用于当前 webview。
	 * `enabled` 是 tab 自身的开关状态——关掉时清空该 tab 的 chip，打开时补推当前文件。
	 */
	private editorContextRefresher: ((enabled: boolean) => void) | null = null;

	setEditorContextRefresher(refresh: ((enabled: boolean) => void) | null): void {
		this.editorContextRefresher = refresh;
	}

	/** tab 切换 / tab 内开关文件上下文时，把当前编辑器上下文同步到本视图。 */
	refreshEditorContext(enabled: boolean): void {
		this.editorContextRefresher?.(enabled);
	}

	/** 宿主注入的字体配置推送钩子（FontConfigHandler.pushInitialConfig）。 */
	private fontConfigPusher: (() => void) | null = null;

	setFontConfigPusher(pusher: (() => void) | null): void {
		this.fontConfigPusher = pusher;
	}

	/** 立即推送字体配置（编辑器字体、已保存的 UI/代码字体）到 webview（frontend_ready 时调用）。 */
	pushFontConfig(): void {
		this.fontConfigPusher?.();
	}

	getChannel(): WebviewChannel {
		return this.channel;
	}

	/**
	 * 当前正在处理的消息来自哪个视图（`view:left` / `panel:<tabId>`）。
	 *
	 * 实例与视图是 1:N，回复默认广播；但「就绪握手」「编辑器上下文刷新」这类
	 * 推送天然只属于发起的那个视图，否则会把状态重复灌给其他视图。
	 */
	private dispatchOrigin: string | null = null;

	setDispatchOrigin(viewId: string | null): void {
		this.dispatchOrigin = viewId;
	}

	getDispatchOrigin(): string | null {
		return this.dispatchOrigin;
	}

	/** 由 ChatInstance 注入：按视图定向投递（`ViewRegistry.callJavaScriptTo`）。 */
	private viewSender: ((viewId: string, fn: string, ...args: string[]) => boolean) | null = null;

	setViewSender(sender: ((viewId: string, fn: string, ...args: string[]) => boolean) | null): void {
		this.viewSender = sender;
	}

	/** 有来源视图时只回给它，否则退回广播。 */
	callJavaScriptToOrigin(functionName: string, ...args: string[]): void {
		const origin = this.dispatchOrigin;
		if (origin && this.viewSender?.(origin, functionName, ...args)) {
			return;
		}
		this.callJavaScript(functionName, ...args);
	}

	/**
	 * 是否已有任意视图发过 `frontend_ready`。
	 *
	 * 视图就绪前调用 `callJavaScript` 会被丢弃（脚本还没挂监听），因此需要
	 * 按视图判断；这个布尔值只是「至少有一个视图可用」的全局近似。
	 */
	private frontendReady = false;

	setFrontendReady(ready: boolean): void {
		this.frontendReady = ready;
	}

	isFrontendReady(): boolean {
		return this.frontendReady;
	}

	/** 由 ChatInstance 注入：把某个视图标记为就绪（转发给 ViewRegistry）。 */
	private viewReadyMarker: ((viewId: string) => void) | null = null;

	setViewReadyMarker(marker: ((viewId: string) => void) | null): void {
		this.viewReadyMarker = marker;
	}

	/** `frontend_ready` 到达时按来源视图标记，其它组件可据此等待视图挂载。 */
	markViewReady(viewId: string | null): void {
		if (viewId) {
			this.viewReadyMarker?.(viewId);
		}
	}

	/** 定向投递给某个视图（新建标签这类「只该发生一次」的动作）。 */
	callJavaScriptToView(viewId: string, functionName: string, ...args: string[]): boolean {
		return this.viewSender?.(viewId, functionName, ...args) ?? false;
	}

	/**
	 * 宿主注入的「把会话带到前台」钩子（TabManager.revealSession）。
	 * 通知点击时用：先 reveal 对应原生 panel，再让该视图切到对应标签。
	 */
	private sessionFocuser: ((sessionId: string) => boolean) | null = null;

	setSessionFocuser(focuser: ((sessionId: string) => boolean) | null): void {
		this.sessionFocuser = focuser;
	}

	/**
	 * @returns 是否已尝试定位（找不到对应 panel 时仍会推给本视图，让视图内
	 *   标签切换生效）。
	 */
	focusSession(sessionId: string): boolean {
		if (!sessionId) {
			return false;
		}
		if (this.sessionFocuser?.(sessionId)) {
			return true;
		}
		this.callJavaScript('focus_session', sessionId);
		return true;
	}

	/** 当前存活 webview 数量；通道未上报时按单视图处理。 */
	getViewCount(): number {
		return this.channel.getViewCount ? this.channel.getViewCount() : 1;
	}

	getSettingsService(): SettingsService {
		return this.settings;
	}

	/** 当前工作目录：自定义 cwd（若配置且有效），否则取第一个工作区根。 */
	resolveEffectiveWorkingDirectory(): string | null {
		return this.settings.getEffectiveWorkingDirectory();
	}

	/** workspace 之外的工作目录兜底（活跃编辑器父目录等）。 */
	getFallbackWorkingDirectory(): string | null {
		return this.fallbackWorkingDir ? this.fallbackWorkingDir() : null;
	}

	private readonly sessions = new Map<string, OpenCodeSession>();

	registerSession(id: string, session: OpenCodeSession): void {
		if (id && session) {
			this.sessions.set(id, session);
		}
	}

	getSessionById(id: string): OpenCodeSession | null {
		return this.sessions.get(id) ?? null;
	}

	removeSession(id: string): void {
		this.sessions.delete(id);
	}

	getSession(id?: string): OpenCodeSession | null {
		if (id) {
			return this.sessions.get(id) ?? (this.sessionManager?.getSession(id) ?? null);
		}
		if (this.sessionManager) {
			return this.sessionManager.getActiveSession();
		}
		return this.session;
	}

	setSession(session: OpenCodeSession | null): void {
		this.session = session;
	}

	getSessionManager(): SessionManager | null {
		return this.sessionManager;
	}

	setSessionManager(sessionManager: SessionManager | null): void {
		this.sessionManager = sessionManager;
	}

	getCurrentModel(): string | null {
		return this.currentModel;
	}

	getCurrentProvider(): string {
		return this.currentProvider;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	setDisposed(disposed: boolean): void {
		this.disposed = disposed;
	}

	setCurrentModel(model: string | null): void {
		this.currentModel = model;
	}

	setCurrentProvider(provider: string): void {
		this.currentProvider = provider;
	}

	// JavaScript callback 代理
	callJavaScript(functionName: string, ...args: string[]): void {
		if (!this.disposed) {
			this.channel.callJavaScript(functionName, ...args);
		}
	}
}
