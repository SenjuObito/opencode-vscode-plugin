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

/** The tab-owned session surface used by the window command dispatcher. */
export interface TabSessionContext {
	getSessionForTab(tabId: string): OpenCodeSession | null;
	createSessionForTab(tabId: string): OpenCodeSession | null;
	getSessionBySessionId(sessionId: string): OpenCodeSession | null;
	getTabIdForSession(sessionId: string): string | null;
	getCwdForTab(tabId: string): string | null;
	getSendSettings(tabId: string): {
		model?: string | null;
		permissionMode?: string | null;
		reasoningEffort?: string | null;
	} | null;
	resolveAttachment(tabId: string, attachmentId: string): {
		data: string;
		fileName: string;
		mediaType: string;
	} | null;
	setContextEnabled(tabId: string, enabled: boolean): void;
	/** User stopped the turn: hold this tab's queue until it is resumed. */
	pauseQueue(tabId: string): void;
	/**
	 * The history of this session finished loading into its tab.
	 *
	 * <p>Loading a session binds the tab and parks it in
	 * {@code LOADING_HISTORY}; the message pump refuses to send while it stays
	 * there. The handler must say when the transcript is in, exactly like idea's
	 * {@code markHistoryLoaded}.</p>
	 */
	markHistoryLoaded(sessionId: string): void;
}

export class HandlerContext {
	private sessionManager: SessionManager | null = null;
	private session: OpenCodeSession | null = null;
	private currentModel: string | null = null;
	private currentProvider = 'opencode';
	private disposed = false;
	private fallbackWorkingDir: (() => string | null) | null = null;
	private daemon: OpenCodeDaemonBridge | null = null;
	private tabSessionContext: TabSessionContext | null = null;
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

	/** Wire the host's tab registry/session factory into window-level handlers. */
	setTabSessionContext(context: TabSessionContext | null): void {
		this.tabSessionContext = context;
	}

	getSessionForTab(tabId: string): OpenCodeSession | null {
		return this.tabSessionContext?.getSessionForTab(tabId) ?? null;
	}

	createSessionForTab(tabId: string): OpenCodeSession | null {
		return this.tabSessionContext?.createSessionForTab(tabId) ?? null;
	}

	getSessionBySessionId(sessionId: string): OpenCodeSession | null {
		return this.tabSessionContext?.getSessionBySessionId(sessionId) ?? null;
	}

	getTabIdForSession(sessionId: string): string | null {
		return this.tabSessionContext?.getTabIdForSession(sessionId) ?? null;
	}

	getCwdForTab(tabId: string): string | null {
		return this.tabSessionContext?.getCwdForTab(tabId) ?? null;
	}

	getSendSettings(tabId: string): {
		model?: string | null;
		permissionMode?: string | null;
		reasoningEffort?: string | null;
	} | null {
		return this.tabSessionContext?.getSendSettings(tabId) ?? null;
	}

	resolveAttachment(tabId: string, attachmentId: string): {
		data: string;
		fileName: string;
		mediaType: string;
	} | null {
		return this.tabSessionContext?.resolveAttachment(tabId, attachmentId) ?? null;
	}

	setTabContextEnabled(tabId: string, enabled: boolean): void {
		this.tabSessionContext?.setContextEnabled(tabId, enabled);
	}

	pauseTabQueue(tabId: string): void {
		this.tabSessionContext?.pauseQueue(tabId);
	}

	/** Tell the window a tab's history load is finished (see {@link TabSessionContext}). */
	markHistoryLoaded(sessionId: string): void {
		this.tabSessionContext?.markHistoryLoaded(sessionId);
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

	/** 宿主注入的字体配置推送钩子（FontConfigHandler.pushInitialConfig）。 */
	private fontConfigPusher: (() => void) | null = null;

	setFontConfigPusher(pusher: (() => void) | null): void {
		this.fontConfigPusher = pusher;
	}

	/** 立即推送字体配置（编辑器字体、已保存的 UI/代码字体）到 webview（frontend_ready 时调用）。 */
	pushFontConfig(): void {
		this.fontConfigPusher?.();
	}

	/**
	 * 语义事件发布器（宿主注入）。
	 *
	 * 处理器把结果按语义事件投回某个 tab（`files.undo` 等），而不是窗口级
	 * `callJavaScript` —— 多 tab 时窗口级回调会把结果送到别的 tab 的视图上。
	 */
	private eventPublisher: ((
		type: string,
		tabId: string,
		payload: Record<string, unknown>,
		options?: { legacy?: boolean; sessionId?: string | null },
	) => void) | null = null;

	setEventPublisher(
		publisher: ((
			type: string,
			tabId: string,
			payload: Record<string, unknown>,
			options?: { legacy?: boolean; sessionId?: string | null },
		) => void) | null,
	): void {
		this.eventPublisher = publisher;
	}

	/**
	 * 把语义事件投给某个 tab。`tabId` 缺失时事件走全局 lane（例如会话还没
	 * 绑定 tab 的 prompt）——请求本身不能丢，丢了服务端会一直等答复。
	 * 返回 false 表示没有发布器（未装配 / 单测）。
	 */
	publishTabEvent(
		type: string,
		tabId: string | null | undefined,
		payload: Record<string, unknown>,
		options?: { legacy?: boolean; sessionId?: string | null },
	): boolean {
		if (!this.eventPublisher) {
			return false;
		}
		this.eventPublisher(type, tabId ?? '', payload, options);
		return true;
	}

	getChannel(): WebviewChannel {
		return this.channel;
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

	getSession(): OpenCodeSession | null {
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
