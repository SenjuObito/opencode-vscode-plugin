/**
 * TabManager — 多标签页会话管理器。
 *
 * 用户点击 VS Code 编辑器上的 OpenCode Buddy 按钮时，直接新建一个独立的对话标签页（WebviewPanel）。
 * 标签页使用标准的 'OpenCode Buddy' 原生标题，无需自增序号。
 *
 * 核心机制：
 * 1. 每个 WebviewPanel 拥有独立的 ChatInstance（包含独立 OpenCodeSession、SingleWebviewChannel 与 handlers）。
 * 2. 独立消息隔离，各个标签页可同时向 daemon 发起提问，并发流式输出，互不干扰。
 * 3. 通过 WebviewBroadcaster 接入全局配置广播，任何标签页修改设置，所有标签页实时同步生效。
 * 4. 设置 retainContextWhenHidden: true，切至后台时保持流式渲染与 DOM 状态。
 * 5. 面板关闭时（onDidDispose）彻底释放资源。
 */
import * as vscode from 'vscode';
import { WebviewChannel } from '../router/HandlerContext';
import { SettingsService } from '../settings/SettingsService';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { ChatInstance, createChatInstance, ChatInstanceDeps } from '../session/ChatInstance';
import { BridgeMessage } from '../types';
import { buildWebviewHtml, parseWirePayload, readWebviewHtml } from '../webview/OpenCodeViewProvider';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';
import { logDiagnostic, logVerbose } from '../util/DiagnosticLogger';

const TAB_VIEW_TYPE = 'opencode-buddy.tab';
const DEFAULT_TAB_TITLE = 'OpenCode Buddy';

import type { EditorContextTracker } from '../context/EditorContextTracker';

export interface TabManagerOptions {
	readonly extensionUri: vscode.Uri;
	readonly settings: SettingsService;
	readonly daemon: OpenCodeDaemonBridge;
	readonly fileOps: ChatInstanceDeps['fileOps'];
	readonly fallbackWorkingDirectoryResolver: () => string | null;
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
	instance: ChatInstance;
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
		tab.unregisterBroadcaster();
		tab.channel.dispose();
		tab.instance.dispose();
		this.tabs.delete(tabId);
		this.options.onLog?.(`[TabManager] closed tab ${tabId}`);
	}

	disposeAll(): void {
		for (const tabId of [...this.tabs.keys()]) {
			this.closeTab(tabId);
		}
	}

	private spawnTab(tabId: string): TabEntry {
		const { extensionUri, settings, daemon, fileOps, fallbackWorkingDirectoryResolver, editorContextTracker } = this.options;
		const panel = vscode.window.createWebviewPanel(
			TAB_VIEW_TYPE,
			DEFAULT_TAB_TITLE,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(extensionUri, 'ai-bridge'),
				],
			},
		);

		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		const iconFile = isDark ? 'opencode-activity-dark.svg' : 'opencode-activity-light.svg';
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', iconFile);

		const channel = new SingleWebviewChannel(panel.webview);
		const unregisterBroadcaster = WebviewBroadcaster.register(channel);

		const instance = createChatInstance({
			channel,
			settings,
			daemon,
			fileOps,
			fallbackWorkingDirectoryResolver,
			editorContextTracker,
		});

		if (this.htmlCache === null) {
			this.htmlCache = readWebviewHtml(extensionUri);
		}
		panel.webview.html = buildWebviewHtml(
			this.htmlCache,
			isDark,
			settings.getUiPreferences(),
		);

		panel.webview.onDidReceiveMessage((message: unknown) => {
			const bridge = message as BridgeMessage | null;
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				logVerbose(`[TabManager] non-bridge message: type=${typeof bridge?.type}`);
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
			logVerbose(`[TabManager] dispatch type=${type} content=${content.substring(0, 200)}`);
			instance.dispatcher.dispatch(type, content);
		});

		panel.onDidDispose(() => this.closeTab(tabId));

		this.options.onLog?.(`[TabManager] opened new chat tab (${tabId})`);
		return { tabId, panel, channel, instance, unregisterBroadcaster };
	}
}
