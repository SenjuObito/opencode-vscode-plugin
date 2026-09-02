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
import { MessageDispatcher } from '../router/MessageDispatcher';
import { WebviewChannel } from '../router/HandlerContext';
import { ViewHost, BridgeMessage } from '../types';
import { logDiagnostic } from '../util/DiagnosticLogger';
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from '../settings/SettingsService';

/**
 * 可接收广播的 webview 宿主：侧边栏视图（WebviewView）或编辑器分栏面板
 * （WebviewPanel）。两者都提供 `.webview` 与 `onDidDispose`，因此广播层不需要
 * 区分它们的来源。
 */
export type BroadcastTarget = vscode.WebviewView | vscode.WebviewPanel;

/** 广播通道：向所有存活 webview 推 `window.<fn>(...args)`。 */
export class BroadcastChannel implements WebviewChannel {
	private readonly views = new Set<BroadcastTarget>();

	attach(view: BroadcastTarget): void {
		this.views.add(view);
		view.onDidDispose(() => this.views.delete(view));
	}

	detachAll(): void {
		this.views.clear();
	}

	get size(): number {
		return this.views.size;
	}

	callJavaScript(functionName: string, ...args: string[]): void {
		this.postRaw({ type: functionName, args });
	}

	postRaw(message: unknown): void {
		const msg = message as { type?: string };
		if (msg?.type === 'onTodoUpdated') {
			console.log('[OpenCodeViewProvider] postRaw sending onTodoUpdated to', this.views.size, 'views');
		}
		for (const view of [...this.views]) {
			try {
				void view.webview.postMessage(message);
			} catch {
				// 面板已销毁：回收该视图
				this.views.delete(view);
			}
		}
	}

	isDisposed(): boolean {
		return this.views.size === 0;
	}
}

export interface OpenCodeViewProviderOptions {
	readonly extensionUri: vscode.Uri;
	readonly host: ViewHost;
	readonly channel: BroadcastChannel;
	readonly dispatcher: MessageDispatcher;
	/** webview 就绪后的额外处理（如回放会话状态）。 */
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
 *
 * 背景：CSS 里 `:root` 变量默认是暗色，而 webview 过去要等 React 挂载、桥接
 * 建好、`get_ide_theme` 往返之后才切主题 —— 浅色 VS Code 下会先闪一帧暗色。
 * 这里把主题决策提前到解析 HTML 的同步阶段，彻底消除闪烁。
 */
export function buildWebviewHtml(rawHtml: string, isDark: boolean, uiPreferences: UiPreferences): string {
	// `<` 转义成 \u003c：JSON 里理论上只会出现枚举/数字/十六进制颜色，但一旦
	// 将来塞进任意字符串，"</script>" 就会提前闭合脚本块。
	const prefsJson = JSON.stringify(uiPreferences).replace(/</g, '\\u003c');
	const bootstrap = [
		'<script>',
		'(function(){try{',
		`var prefs=${prefsJson};`,
		`var ideTheme=${JSON.stringify(isDark ? 'dark' : 'light')};`,
		'window.__INITIAL_IDE_THEME__=ideTheme;',
		'window.__INITIAL_UI_PREFERENCES__=prefs;',
		// localStorage 里可能有更近一次的同会话写入；缺失时用宿主权威值兜底。
		'try{var lt=localStorage.getItem("theme");if(lt==="light"||lt==="dark"||lt==="system"){prefs.theme=lt;}}catch(e){}',
		'var theme=prefs.theme==="light"||prefs.theme==="dark"?prefs.theme:ideTheme;',
		'document.documentElement.setAttribute("data-theme",theme);',
		'var m={1:0.8,2:0.9,3:1.0,4:1.1,5:1.2,6:1.4};',
		'document.documentElement.style.setProperty("--font-scale",String(m[prefs.fontSizeLevel]||1.0));',
		'}catch(e){}})();',
		'</script>',
	].join('');

	const headTag = '<head>';
	const headIndex = rawHtml.indexOf(headTag);
	if (headIndex >= 0) {
		const insertAt = headIndex + headTag.length;
		return rawHtml.slice(0, insertAt) + bootstrap + rawHtml.slice(insertAt);
	}
	return bootstrap + rawHtml;
}

export class OpenCodeViewProvider implements vscode.WebviewViewProvider {
	private readonly extensionUri: vscode.Uri;
	private readonly host: ViewHost;
	private readonly channel: BroadcastChannel;
	private readonly dispatcher: MessageDispatcher;
	private readonly onReady?: (host: ViewHost) => void;
	/** 提供权威 UI 偏好（globalState），注入到引导脚本里。 */
	private readonly getUiPreferences: () => UiPreferences;
	private view: vscode.WebviewView | null = null;
	private html: string | null = null;

	constructor(options: OpenCodeViewProviderOptions & { getUiPreferences?: () => UiPreferences }) {
		this.extensionUri = options.extensionUri;
		this.host = options.host;
		this.channel = options.channel;
		this.dispatcher = options.dispatcher;
		this.onReady = options.onReady;
		this.getUiPreferences = options.getUiPreferences
			?? (() => ({ ...DEFAULT_UI_PREFERENCES }));
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext<unknown>,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.title = this.host === 'left' ? 'OpenCode' : 'OpenCode';

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
		// 每次 resolve 重新生成：主题可能已经切换，UI 偏好也可能刚被改写。
		webviewView.webview.html = buildWebviewHtml(
			this.html,
			vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light,
			this.getUiPreferences(),
		);

		this.channel.attach(webviewView);

		webviewView.webview.onDidReceiveMessage((message: unknown) => {
			const bridge = message as BridgeMessage | null;
			logDiagnostic(`[OpenCodeViewProvider] RAW message: type=${typeof bridge?.type} keys=${bridge && typeof bridge === 'object' ? Object.keys(bridge).join(',') : 'N/A'} payloadPreview=${String(bridge?.payload).substring(0, 80)}`);
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				logDiagnostic(`[OpenCodeViewProvider] non-bridge message: type=${typeof bridge?.type} payload=${String(bridge?.payload).substring(0, 100)}`);
				return;
			}
			const { type, content } = parseWirePayload(bridge.payload);
			if (!type) {
				logDiagnostic(`[OpenCodeViewProvider] empty type from payload: ${bridge.payload.substring(0, 200)}`);
				return;
			}
		// Webview debug logs — forwarded here from the webview via the cardDebug
		// bridge event so they appear in the «OpenCode GUI» Output channel.
		if (type === 'cardDebug') {
			logDiagnostic(`[Webview] ${content}`);
			return;
		}
		logDiagnostic(`[OpenCodeViewProvider] dispatch type=${type} content=${content.substring(0, 200)}`);
			this.dispatcher.dispatch(type, content);
		});

		this.onReady?.(this.host);
	}

	/** 该面板的存活 webview（用于判断是否可交互）。 */
	isVisible(): boolean {
		return this.view != null && this.view.visible;
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
