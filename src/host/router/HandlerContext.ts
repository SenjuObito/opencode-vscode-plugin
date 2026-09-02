/**
 * HandlerContext — port of cc-gui `handler/core/HandlerContext.java`.
 * Provides shared resources for message handlers: the webview channel,
 * the current session, model/provider, and settings.
 */
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SettingsService } from '../settings/SettingsService';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';

/** Webview 桥：向 `window.<fn>` 推消息。 */
export interface WebviewChannel {
	callJavaScript(functionName: string, ...args: string[]): void;
	isDisposed(): boolean;
	postRaw(message: unknown): void;
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

	getChannel(): WebviewChannel {
		return this.channel;
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
		return this.session;
	}

	setSession(session: OpenCodeSession | null): void {
		this.session = session;
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
