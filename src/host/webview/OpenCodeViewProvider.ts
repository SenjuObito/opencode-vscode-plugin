/**
 * OpenCodeViewProvider — VS Code 版的 WebviewViewProvider，对应 cc-gui 的
 * JCEF toolwindow 双面板（activity bar + secondary sidebar）。
 *
 * 两个面板（left / right）渲染同一份 React 单文件 bundle，共享同一个
 * HandlerContext / OpenCodeSession / daemon。宿主 → webview 用广播
 * （BroadcastChannel：postMessage 到所有存活 webview）；webview → 宿主
 * 走 `{ type:'bridge', payload: '<type>:<content>' }`，解析后交给共享的
 * MessageDispatcher。
 */
import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { WebviewChannel, FileOps } from '../router/HandlerContext';
import { ViewHost, BridgeMessage } from '../types';
import { logDiagnostic, logVerbose } from '../util/DiagnosticLogger';
import { DEFAULT_UI_PREFERENCES, type UiPreferences, type SettingsService } from '../settings/SettingsService';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import type { EditorContextTracker } from '../context/EditorContextTracker';
import type { TabManager } from '../tabs/TabManager';
import { createChatInstance, type ChatInstance } from '../session/ChatInstance';
import { TabHandler } from '../handlers/TabHandler';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';

/**
 * 可接收广播的 webview 宿主：侧边栏视图（WebviewView）或编辑器分栏面板
 * （WebviewPanel）。两者都提供 `.webview` 与 `onDidDispose`，因此广播层不需要
 * 区分它们的来源。
 */
export type BroadcastTarget = vscode.WebviewView | vscode.WebviewPanel;

export class ProviderWebviewChannel implements WebviewChannel {
	private view: vscode.WebviewView | null = null;
	private disposed = false;

	attach(view: vscode.WebviewView): void {
		this.view = view;
		this.disposed = false;
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = null;
			}
		});
	}

	callJavaScript(functionName: string, ...args: string[]): void {
		this.postRaw({ type: functionName, args });
	}

	postRaw(message: unknown): void {
		if (this.disposed || !this.view) {
			return;
		}
		try {
			void this.view.webview.postMessage(message);
		} catch {
			// view 已销毁
		}
	}

	getViewCount(): number {
		return this.view ? 1 : 0;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
		this.view = null;
	}
}

export interface OpenCodeViewProviderOptions {
	readonly extensionUri: vscode.Uri;
	readonly host: ViewHost;
	readonly settings: SettingsService;
	readonly daemon: OpenCodeDaemonBridge;
	readonly fileOps: FileOps;
	readonly fallbackWorkingDirectoryResolver: () => string | null;
	readonly editorContextTracker?: EditorContextTracker;
	readonly tabManager?: TabManager;
	readonly getUiPreferences?: () => UiPreferences;
	readonly onReady?: (host: ViewHost) => void;
}

/** 读取打包后的 webview 单文件 HTML（内容稳定，可跨面板缓存）。 */
export function readWebviewHtml(extensionUri: vscode.Uri): string {
	const htmlPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.html');
	return readFileSync(htmlPath.fsPath, 'utf-8');
}

/**
 * 在 `<head>` 之后插入一段同步引导脚本，把 IDE 主题与已持久化的 UI 偏好在
 * 首帧之前写进 DOM。
 */
export function buildWebviewHtml(rawHtml: string, isDark: boolean, uiPreferences: UiPreferences): string {
	const prefsJson = JSON.stringify(uiPreferences).replace(/</g, '\\u003c');
	const bootstrap = [
		'<script>',
		'(function(){try{',
		`var prefs=${prefsJson};`,
		`var ideTheme=${JSON.stringify(isDark ? 'dark' : 'light')};`,
		'window.__INITIAL_IDE_THEME__=ideTheme;',
		'window.__INITIAL_UI_PREFERENCES__=prefs;',
		'try{var lt=localStorage.getItem("theme");if(lt==="light"||lt==="dark"||lt==="system"){prefs.theme=lt;}}catch(e){}',
		'var theme=prefs.theme==="light"||prefs.theme==="dark"?prefs.theme:ideTheme;',
		'document.documentElement.setAttribute("data-theme",theme);',
		'var m={1:0.8,2:0.9,3:1.0,4:1.1,5:1.2,6:1.4};',
		'document.documentElement.style.setProperty("--font-scale",String(m[prefs.fontSizeLevel]||1.0));',
		'}catch(e){}})();',
		'</script>',
	].join('');

	const headMatch = /<head(?:\s[^>]*)?>/i.exec(rawHtml);
	if (headMatch) {
		const insertAt = headMatch.index + headMatch[0].length;
		return rawHtml.slice(0, insertAt) + bootstrap + rawHtml.slice(insertAt);
	}
	const htmlMatch = /<html(?:\s[^>]*)?>/i.exec(rawHtml);
	if (htmlMatch) {
		const insertAt = htmlMatch.index + htmlMatch[0].length;
		return rawHtml.slice(0, insertAt) + bootstrap + rawHtml.slice(insertAt);
	}
	return bootstrap + rawHtml;
}

export class OpenCodeViewProvider implements vscode.WebviewViewProvider {
	private readonly extensionUri: vscode.Uri;
	private readonly host: ViewHost;
	private readonly channel: ProviderWebviewChannel;
	private readonly instance: ChatInstance;
	private readonly onReady?: (host: ViewHost) => void;
	private readonly getUiPreferences: () => UiPreferences;
	private view: vscode.WebviewView | null = null;
	private html: string | null = null;
	private readonly unregisterBroadcaster: () => void;

	constructor(options: OpenCodeViewProviderOptions) {
		this.extensionUri = options.extensionUri;
		this.host = options.host;
		this.channel = new ProviderWebviewChannel();
		this.unregisterBroadcaster = WebviewBroadcaster.register(this.channel);
		this.getUiPreferences = options.getUiPreferences
			?? (() => ({ ...DEFAULT_UI_PREFERENCES }));
		this.onReady = options.onReady;

		this.instance = createChatInstance({
			channel: this.channel,
			settings: options.settings,
			daemon: options.daemon,
			fileOps: options.fileOps,
			fallbackWorkingDirectoryResolver: options.fallbackWorkingDirectoryResolver,
			editorContextTracker: options.editorContextTracker,
		});

		if (options.tabManager) {
			this.instance.dispatcher.registerHandler(new TabHandler(this.instance.context, options.tabManager));
		}
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext<unknown>,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.title = 'OpenCode Buddy';

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
				vscode.Uri.joinPath(this.extensionUri, 'ai-bridge'),
			],
		};

		if (this.html === null) {
			this.html = readWebviewHtml(this.extensionUri);
		}
		webviewView.webview.html = buildWebviewHtml(
			this.html,
			vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light,
			this.getUiPreferences(),
		);

		this.channel.attach(webviewView);

		webviewView.webview.onDidReceiveMessage((message: unknown) => {
			const bridge = message as BridgeMessage | null;
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				logVerbose(`[OpenCodeViewProvider:${this.host}] non-bridge message: type=${typeof bridge?.type}`);
				return;
			}
			const { type, content } = parseWirePayload(bridge.payload);
			if (!type) {
				return;
			}
			if (type === 'cardDebug') {
				logDiagnostic(`[Webview] ${content}`, 'Webview');
				return;
			}
			logVerbose(`[OpenCodeViewProvider:${this.host}] dispatch type=${type} content=${content.substring(0, 200)}`);
			this.instance.dispatcher.dispatch(type, content);
		});

		this.onReady?.(this.host);
	}

	isVisible(): boolean {
		return this.view != null && this.view.visible;
	}

	dispose(): void {
		this.unregisterBroadcaster();
		this.channel.dispose();
		this.instance.dispose();
	}
}

/** 解析 `type:content` 线格式（cc-gui 协议，按第一个冒号切分）。 */
export function parseWirePayload(payload: string): { type: string; content: string } {
	const sep = payload.indexOf(':');
	if (sep <= 0) {
		return { type: '', content: '' };
	}
	return {
		type: payload.slice(0, sep),
		content: payload.slice(sep + 1),
	};
}
