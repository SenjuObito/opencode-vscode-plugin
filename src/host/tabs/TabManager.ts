/**
 * TabManager — 编辑器里的对话窗口（WebviewPanel）管理器。
 *
 * 角色已经变了：它不再拥有会话。整个扩展只有一个 `ChatInstance`，这里的每个
 * panel 只是该实例的一个挂载点（另一个窗口），与会话、标签一一对应的是
 * webview 里的聊天标签，而不是窗口。
 *
 * 因此：
 * 1. 新建窗口 ≠ 新建会话 —— 新窗口显示的是同一份内容；
 * 2. 关闭窗口只解绑视图，会话与聊天标签都留在实例里；
 * 3. 窗口之间不需要各自的消息通道，实例的广播会同时抵达所有窗口。
 */
import * as vscode from 'vscode';
import { WebviewChannel } from '../router/HandlerContext';
import { SettingsService } from '../settings/SettingsService';
import { ChatInstance } from '../session/ChatInstance';
import { BridgeMessage } from '../types';
import { buildWebviewHtml, parseWirePayload, readWebviewHtml } from '../webview/OpenCodeViewProvider';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';
import { logDiagnostic, logVerbose } from '../util/DiagnosticLogger';

const TAB_VIEW_TYPE = 'opencode-buddy.tab';
const DEFAULT_TAB_TITLE = 'OpenCode Buddy';

export interface TabManagerOptions {
	readonly extensionUri: vscode.Uri;
	readonly settings: SettingsService;
	/** 全局唯一的聊天实例；所有窗口挂载到它。 */
	readonly instance: ChatInstance;
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
	detachView: () => void;
}

export class TabManager {
	private readonly tabs = new Map<string, TabEntry>();
	private tabCounter = 0;
	private htmlCache: string | null = null;
	/** 新窗口还没就绪时挂起的「新建对话」，等该视图 frontend_ready 后补发。 */
	private readonly pendingNewChat = new Set<string>();
	private readonly unregisterReady: () => void;

	constructor(private readonly options: TabManagerOptions) {
		this.unregisterReady = this.options.instance.onViewReady((viewId) => {
			if (!this.pendingNewChat.delete(viewId)) {
				return;
			}
			this.options.instance.context.callJavaScriptToView(viewId, 'createSessionTab');
		});
	}

	/**
	 * 「新建对话」命令的入口。
	 *
	 * 标签是全局的：真正的「新建」只能发生在一个视图里（`createSessionTab`
	 * 内部负责「至多一个未绑定草稿」的去重），然后由宿主广播给其余视图。
	 * 有窗口就投给它；一个都没有才先开窗口，并等它就绪后再补发。
	 */
	openChat(): void {
		const readyIds = this.options.instance.getReadyViewIds();
		// 优先投给编辑器窗口（用户正在对话的地方），否则任意一个已就绪视图
		// （左右侧边栏）。没有就绪视图才开窗口，避免「点了命令弹出一个空窗口」。
		const panelViewIds = [...this.tabs.keys()].map((tabId) => `panel:${tabId}`);
		const target = panelViewIds.find((id) => readyIds.includes(id))
			?? readyIds[0];
		if (target) {
			this.options.instance.context.callJavaScriptToView(target, 'createSessionTab');
			return;
		}
		const tabId = this.openNewTab();
		this.pendingNewChat.add(`panel:${tabId}`);
	}

	getTabCount(): number {
		return this.tabs.size;
	}

	getOpenTabIds(): string[] {
		return [...this.tabs.keys()];
	}

	/** 打开一个新的对话窗口（同一实例的又一个视图）。 */
	openNewTab(): string {
		const tabId = `tab_${Date.now()}_${++this.tabCounter}`;
		const panel = vscode.window.createWebviewPanel(
			TAB_VIEW_TYPE,
			DEFAULT_TAB_TITLE,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview'),
				],
			},
		);
		const entry = this.attachTab(tabId, panel);
		this.tabs.set(tabId, entry);
		return tabId;
	}

	/** 关闭窗口：只解绑视图，不触碰实例与会话。 */
	closeTab(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return;
		}
		tab.detachView();
		tab.unregisterBroadcaster();
		tab.channel.dispose();
		this.tabs.delete(tabId);
		this.options.onLog?.(`[TabManager] closed view ${tabId}`);
	}

	disposeAll(): void {
		this.unregisterReady();
		for (const tabId of [...this.tabs.keys()]) {
			this.closeTab(tabId);
		}
	}

	/** VS Code 恢复 panel 时接管它（视图重新挂载，不涉及会话绑定）。 */
	adoptRestoredPanel(panel: vscode.WebviewPanel): string | null {
		let tabId = `tab_${Date.now()}_${++this.tabCounter}`;
		while (this.tabs.has(tabId)) {
			tabId = `tab_${Date.now()}_${++this.tabCounter}`;
		}
		const entry = this.attachTab(tabId, panel);
		this.tabs.set(tabId, entry);
		return tabId;
	}

	/**
	 * 把某个会话带到前台（通知点击「查看」）。
	 *
	 * 单实例下不再需要「在哪个实例里找会话」：会话存在就广播一次
	 * `focus_session`，所有窗口一起切到该标签；若还有窗口，顺手 reveal 一个。
	 */
	revealSession(sessionId: string): boolean {
		if (!sessionId || !this.options.instance.sessionManager.hasSession(sessionId)) {
			return false;
		}
		const first = this.tabs.values().next().value as TabEntry | undefined;
		first?.panel.reveal(undefined, false);
		this.options.instance.context.callJavaScript('focus_session', sessionId);
		return true;
	}

	/** 为一个已存在的 panel 装配视图通道与监听（新建与恢复共用）。 */
	private attachTab(tabId: string, panel: vscode.WebviewPanel): TabEntry {
		const { extensionUri, settings, instance } = this.options;

		if (this.htmlCache === null) {
			this.htmlCache = readWebviewHtml(extensionUri);
		}

		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		const iconFile = isDark ? 'opencode-activity-dark.svg' : 'opencode-activity-light.svg';
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', iconFile);

		const channel = new SingleWebviewChannel(panel.webview);
		const unregisterBroadcaster = WebviewBroadcaster.register(channel);
		const viewId = `panel:${tabId}`;
		const detachView = instance.attachView({
			id: viewId,
			kind: 'panel',
			channel,
			isVisible: () => panel.visible,
		});

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
			instance.dispatchFrom(viewId, type, content);
		});

		panel.onDidDispose(() => this.closeTab(tabId));

		this.options.onLog?.(`[TabManager] opened view (${tabId})`);
		return { tabId, panel, channel, unregisterBroadcaster, detachView };
	}
}
