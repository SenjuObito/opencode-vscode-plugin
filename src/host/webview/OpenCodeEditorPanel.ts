/**
 * OpenCodeEditorPanel — 编辑器区域的「分栏对话窗口」。
 *
 * 与 OpenCodeViewProvider（侧边栏的左/右视图）共享同一份 React bundle、
 * 同一个 BroadcastChannel 与 MessageDispatcher，因此：
 *   - 宿主 → webview：BroadcastChannel 广播，所有存活面板（含本窗口）都会收到；
 *   - webview → 宿主：走 `{ type:'bridge', payload: '<type>:<content>' }`
 *     → MessageDispatcher，与侧边栏完全一致。
 *
 * 会话状态由 OpenCodeSession 统一持有，所以分栏窗口与侧边栏看到的是同一会话，
 * 打开分栏窗口不需要（也不应该）另起一份会话或 daemon。
 */
import * as vscode from 'vscode';
import { MessageDispatcher } from '../router/MessageDispatcher';
import { BridgeMessage, ViewHost } from '../types';
import { logDiagnostic } from '../util/DiagnosticLogger';
import {
	BroadcastChannel,
	buildWebviewHtml,
	parseWirePayload,
	readWebviewHtml,
} from './OpenCodeViewProvider';
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from '../settings/SettingsService';

/** 分栏窗口的 viewType（也用于 package.json 之外的实例识别）。 */
const VIEW_TYPE = 'opencode-buddy.editorChat';

export interface OpenCodeEditorPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly channel: BroadcastChannel;
	readonly dispatcher: MessageDispatcher;
	/** webview 挂载后的额外处理（与侧边栏视图保持一致）。 */
	readonly onReady?: (host: ViewHost) => void;
	/** 提供权威 UI 偏好（globalState），注入到引导脚本里。 */
	readonly getUiPreferences?: () => UiPreferences;
}

export class OpenCodeEditorPanel {
	private static current: vscode.WebviewPanel | null = null;
	private static html: string | null = null;
	private readonly options: OpenCodeEditorPanelOptions;

	constructor(options: OpenCodeEditorPanelOptions) {
		this.options = options;
	}

	/** 分栏窗口当前是否打开。 */
	get isOpen(): boolean {
		return OpenCodeEditorPanel.current != null;
	}

	/**
	 * 在编辑器区域打开 OpenCode 分栏窗口。
	 *
	 * 已存在时直接 reveal（复用同一个窗口），避免重复点击产生多个独立窗口——
	 * 多个窗口共享同一会话，重复创建既浪费资源也会让用户以为会话被拆开了。
	 */
	open(): void {
		const existing = OpenCodeEditorPanel.current;
		if (existing) {
			existing.reveal(undefined, false);
			return;
		}

		const panel = this.createPanel();
		OpenCodeEditorPanel.current = panel;
		this.options.channel.attach(panel);
		this.wireMessages(panel);
		panel.onDidDispose(() => {
			if (OpenCodeEditorPanel.current === panel) {
				OpenCodeEditorPanel.current = null;
			}
		});

		// 与侧边栏视图保持一致的挂载后处理；真正的初始配置由 webview 就绪后
		// 发来的 frontend_ready 触发（BroadcastChannel 会补推一次）。
		this.options.onReady?.('right');
	}

	private createPanel(): vscode.WebviewPanel {
		const { extensionUri } = this.options;
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			'OpenCode Buddy',
			// Beside = 在当前编辑器旁边分栏，而不是占用左/右侧边栏。
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(extensionUri, 'ai-bridge'),
				],
				// 切到其他编辑器标签时保留会话上下文，避免回来时整个 UI 重载。
				retainContextWhenHidden: true,
			},
		);
		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		const iconFile = isDark ? 'opencode-activity-dark.svg' : 'opencode-activity-light.svg';
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', iconFile);

		if (OpenCodeEditorPanel.html === null) {
			OpenCodeEditorPanel.html = readWebviewHtml(extensionUri);
		}
		panel.webview.html = buildWebviewHtml(
			OpenCodeEditorPanel.html,
			vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light,
			this.options.getUiPreferences?.() ?? { ...DEFAULT_UI_PREFERENCES },
		);
		return panel;
	}

	private wireMessages(panel: vscode.WebviewPanel): void {
		panel.webview.onDidReceiveMessage((message: unknown) => {
			const bridge = message as BridgeMessage | null;
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				return;
			}
			const { type, content } = parseWirePayload(bridge.payload);
			if (!type) {
				return;
			}
			// Webview debug logs — 转发到 «OpenCode Buddy» 输出通道。
			if (type === 'cardDebug') {
				logDiagnostic(`[Webview] ${content}`);
				return;
			}
			this.options.dispatcher.dispatch(type, content);
		});
	}
}
