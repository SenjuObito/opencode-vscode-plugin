/**
 * TabManager — 多标签页会话管理，对应 cc-gui `ui/toolwindow/ClaudeSDKToolWindow`
 * 的 tab 生命周期（创建 / 命名 / 会话绑定持久化）。
 *
 * cc-gui 每个 tab 是 IntelliJ 的原生 tab + 独立 `ClaudeChatWindow`。VS Code 的
 * 等价物是 `vscode.window.createWebviewPanel`（原生编辑器 tab），每个 tab 用
 * `createChatInstance` 装配一套独立 channel/context/session/handlers。
 *
 *   create_new_tab（webview）→ TabManager.createNewTab()
 *     → createWebviewPanel('opencode-x.tab', name)
 *     → SingleWebviewChannel(panel) → ChatInstance → HTML → message 路由
 *     → TabStateService.saveTabName / saveTabSessionState
 */
import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { WebviewChannel } from '../router/HandlerContext';
import { SettingsService, SettingsStore } from '../settings/SettingsService';
import { TabStateService, TabSessionState } from '../settings/TabStateService';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { ChatInstance, createChatInstance, ChatInstanceDeps } from '../session/ChatInstance';
import { BridgeMessage } from '../types';
import { parseWirePayload } from '../webview/OpenCodeViewProvider';

const TAB_VIEW_TYPE = 'opencode-x.tab';

export interface TabManagerOptions {
	readonly extensionUri: vscode.Uri;
	readonly settings: SettingsService;
	readonly settingsStore: SettingsStore;
	readonly daemon: OpenCodeDaemonBridge;
	readonly fileOps: ChatInstanceDeps['fileOps'];
	readonly fallbackWorkingDirectoryResolver: () => string | null;
	/** 依赖就绪回调（重启后恢复标签页时触发）。 */
	readonly onTabOpened?: (tabId: string) => void;
	readonly onLog?: (message: string) => void;
}

/** 单个 WebviewPanel 的 channel：callJavaScript 只发给该面板。 */
class SingleWebviewChannel implements WebviewChannel {
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
	name: string;
	panel: vscode.WebviewPanel;
	channel: SingleWebviewChannel;
	instance: ChatInstance;
}

export class TabManager {
	private readonly tabState: TabStateService;
	private readonly tabs = new Map<string, TabEntry>();
	private htmlCache: string | null = null;

	constructor(private readonly options: TabManagerOptions) {
		this.tabState = new TabStateService(options.settingsStore);
	}

	getTabCount(): number {
		return this.tabs.size;
	}

	getOpenTabIds(): string[] {
		return [...this.tabs.keys()];
	}

	/** 打开一个全新的标签页（cc-gui create_new_tab）。 */
	openNewTab(): string {
		const tabId = this.tabState.getNextTabIndex();
		const name = this.tabState.getNextTabName();
		const tab = this.spawnTab(tabId, name);
		this.tabs.set(tabId, tab);
		this.options.onTabOpened?.(tabId);
		return tabId;
	}

	/** 关闭并清理一个标签页（面板 dispose 时由宿主调用）。 */
	closeTab(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return;
		}
		this.tabState.saveTabSessionState(tabId, this.snapshotSession(tab));
		tab.channel.dispose();
		tab.instance.dispose();
		this.tabs.delete(tabId);
		this.options.onLog?.(`[TabManager] closed tab ${tab.name}`);
	}

	disposeAll(): void {
		for (const tabId of [...this.tabs.keys()]) {
			this.closeTab(tabId);
		}
	}

	/** 快照当前会话绑定（供 TabStateService 持久化）。 */
	private snapshotSession(tab: TabEntry): TabSessionState {
		const session = tab.instance.session;
		return {
			provider: 'opencode',
			sessionId: session.state.getSessionId(),
			cwd: session.state.getCwd(),
			model: session.state.getModel(),
			permissionMode: session.state.getPermissionMode(),
			reasoningEffort: session.state.getReasoningEffort(),
		};
	}

	private spawnTab(tabId: string, name: string): TabEntry {
		const panel = vscode.window.createWebviewPanel(TAB_VIEW_TYPE, name, vscode.ViewColumn.Beside, {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview'),
				vscode.Uri.joinPath(this.options.extensionUri, 'ai-bridge'),
			],
		});
		const channel = new SingleWebviewChannel(panel.webview);

		const instance = createChatInstance({
			channel,
			settings: this.options.settings,
			daemon: this.options.daemon,
			fileOps: this.options.fileOps,
			fallbackWorkingDirectoryResolver: this.options.fallbackWorkingDirectoryResolver,
		});

		panel.webview.html = this.loadHtml();

		panel.webview.onDidReceiveMessage((message: unknown) => {
			const bridge = message as BridgeMessage | null;
			if (!bridge || bridge.type !== 'bridge' || typeof bridge.payload !== 'string') {
				console.error(`[TabManager] non-bridge message: type=${typeof bridge?.type} payload=${String(bridge?.payload).substring(0, 100)}`);
				return;
			}
			const { type, content } = parseWirePayload(bridge.payload);
			if (!type) {
				console.error(`[TabManager] empty type from payload: ${bridge.payload.substring(0, 200)}`);
				return;
			}
			console.log(`[TabManager] dispatch type=${type} content=${content.substring(0, 200)}`);
			instance.dispatcher.dispatch(type, content);
		});

		panel.onDidDispose(() => this.closeTab(tabId));

		this.tabState.saveTabName(tabId, name);
		this.options.onLog?.(`[TabManager] opened tab ${name} (${tabId})`);
		return { tabId, name, panel, channel, instance };
	}

	private loadHtml(): string {
		if (this.htmlCache !== null) {
			return this.htmlCache;
		}
		const htmlPath = vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview', 'index.html');
		this.htmlCache = readFileSync(htmlPath.fsPath, 'utf-8');
		return this.htmlCache;
	}
}
