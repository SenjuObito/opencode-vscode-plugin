/**
 * TabManager — 多标签页会话管理器。
 *
 * 用户点击 VS Code 编辑器上的 OpenCode Buddy 按钮时，直接新建一个独立的对话标签页（WebviewPanel）。
 * 标签页使用标准的 'OpenCode Buddy' 原生标题，无需自增序号。
 *
 * 核心机制（P8-A1 后）：
 * 1. **单实例多视图**：所有 WebviewPanel（以及左右侧边栏）共享同一个 ChatInstance 与
 *    ChatWindow；会话归 tab 所有（`TabRegistry`），不再「一个面板一个 ChatInstance」。
 * 2. 面板只是视图：同一个 tab 列表在所有视图里一致，切换 tab 由宿主回放快照。
 * 3. 通过 WebviewBroadcaster 接入全局配置广播，任何面板修改设置，所有面板实时同步生效。
 * 4. 设置 retainContextWhenHidden: true，切至后台时保持流式渲染与 DOM 状态。
 * 5. 面板关闭时（onDidDispose）只注销该视图，不销毁共享实例。
 */
import * as vscode from 'vscode';
import { WebviewChannel } from '../router/HandlerContext';
import { SettingsService } from '../settings/SettingsService';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { ChatInstance, ChatInstanceDeps } from '../session/ChatInstance';
import { BridgeMessage } from '../types';
import { buildWebviewHtml, parseWirePayload, readWebviewHtml } from '../webview/OpenCodeViewProvider';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';
import { logDiagnostic, logVerbose } from '../util/DiagnosticLogger';
import type { ChatWindow } from '../window/ChatWindow';

const TAB_VIEW_TYPE = 'opencode-buddy.tab';
const DEFAULT_TAB_TITLE = 'OpenCode Buddy';

import type { EditorContextTracker } from '../context/EditorContextTracker';

export interface TabManagerOptions {
	readonly extensionUri: vscode.Uri;
	readonly settings: SettingsService;
	readonly daemon: OpenCodeDaemonBridge;
	readonly fileOps: ChatInstanceDeps['fileOps'];
	readonly fallbackWorkingDirectoryResolver: () => string | null;
	readonly chatWindow: ChatWindow;
	/** 全窗口共享的聊天实例（handlers / 会话层）；面板不再各自创建。 */
	readonly instance: ChatInstance;
	readonly editorContextTracker?: EditorContextTracker;
	readonly onLog?: (message: string) => void;
}

/** 单个 WebviewPanel 的 channel：callJavaScript 只发给该面板。 */
export class SingleWebviewChannel implements WebviewChannel {
	private disposed = false;
	constructor(private readonly webview: vscode.Webview) {}

	callJavaScript(functionName: string, ...args: string[]): void {
		this.postRaw({ type: functionName, args });
	}

	postRaw(message: unknown): void {
		if (this.disposed) {
			return;
		}
		try {
			void this.webview.postMessage(message);
		} catch {
			// 面板已销毁
		}
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface TabEntry {
	tabId: string;
	panel: vscode.WebviewPanel;
	channel: SingleWebviewChannel;
	unregisterBroadcaster: () => void;
}

export class TabManager {
	private readonly tabs = new Map<string, TabEntry>();
	private tabCounter = 0;
	private htmlCache: string | null = null;

	constructor(private readonly options: TabManagerOptions) {}

	getTabCount(): number {
		return this.tabs.size;
	}

	getOpenTabIds(): string[] {
		return [...this.tabs.keys()];
	}

	/** 新建并打开一个独立的对话标签页 */
	openNewTab(): string {
		const tabId = `tab_${Date.now()}_${++this.tabCounter}`;
		const tab = this.spawnTab(tabId);
		this.tabs.set(tabId, tab);
		return tabId;
	}

	/** 关闭并清理一个标签页 */
	closeTab(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return;
		}
		this.options.chatWindow.unregisterView(tabId);
		tab.unregisterBroadcaster();
		tab.channel.dispose();
		this.tabs.delete(tabId);
		this.options.onLog?.(`[TabManager] closed tab ${tabId}`);
	}

	disposeAll(): void {
		for (const tabId of [...this.tabs.keys()]) {
			this.closeTab(tabId);
		}
	}

	private spawnTab(tabId: string): TabEntry {
		const { extensionUri, settings } = this.options;
		const panel = vscode.window.createWebviewPanel(
			TAB_VIEW_TYPE,
			DEFAULT_TAB_TITLE,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
				],
			},
		);

		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		const iconFile = isDark ? 'opencode-activity-dark.svg' : 'opencode-activity-light.svg';
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', iconFile);

		const channel = new SingleWebviewChannel(panel.webview);
		const unregisterBroadcaster = WebviewBroadcaster.register(channel);

		this.options.chatWindow.registerView(tabId, channel);

		panel.onDidChangeViewState((e) => {
			this.options.chatWindow.viewRegistry.setVisible(tabId, e.webviewPanel.visible);
			this.options.chatWindow.viewRegistry.setFocused(tabId, e.webviewPanel.active);
		});

		const instance = this.options.instance;

		if (this.htmlCache === null) {
			this.htmlCache = readWebviewHtml(extensionUri);
		}
		panel.webview.html = buildWebviewHtml(
			this.htmlCache,
			isDark,
			settings.getUiPreferences(),
			tabId,
		);

		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			const bridge = message as BridgeMessage | null;
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				if (message && typeof message === 'object') {
					await this.options.chatWindow.handleViewCommand(tabId, message);
				} else {
					logVerbose(`[TabManager] non-bridge message: type=${typeof bridge?.type}`);
				}
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
			if (type === 'host_command') {
				try {
					const commandObj = JSON.parse(content);
					await this.options.chatWindow.handleViewCommand(tabId, commandObj);
				} catch (e) {
					logDiagnostic(`[TabManager] Failed to parse host_command: ${content}`, 'error');
				}
				return;
			}
			logVerbose(`[TabManager] dispatch type=${type} content=${content.substring(0, 200)}`);
			instance.dispatcher.dispatch(type, content);
		});

		panel.onDidDispose(() => this.closeTab(tabId));

		this.options.onLog?.(`[TabManager] opened new chat tab (${tabId})`);
		return { tabId, panel, channel, unregisterBroadcaster };
	}
}
