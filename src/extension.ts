/**
 * extension.ts — VS Code 扩展入口。装配常驻 opencode daemon、会话层与全部
 * message handlers，注册左右双 WebviewViewProvider（同一套 React UI）。
 *
 * 服务装配顺序：
 *   SettingsService(store) → HandlerContext(channel) → handlers(dispatcher)
 *   → OpenCodeDaemonBridge → OpenCodeSession → 注入 context → daemon 预热
 */
import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

import { BroadcastChannel, OpenCodeViewProvider } from './host/webview/OpenCodeViewProvider.js';
import { OpenCodeEditorPanel } from './host/webview/OpenCodeEditorPanel.js';
import { HandlerContext, FileOps } from './host/router/HandlerContext.js';
import { MessageDispatcher } from './host/router/MessageDispatcher.js';
import { OpenCodeDaemonBridge } from './host/provider/OpenCodeDaemonBridge.js';
import { OpenCodeSession } from './host/session/OpenCodeSession.js';
import { MementoSettingsStore, SettingsService } from './host/settings/SettingsService.js';
import { NotificationService } from './host/notifications/NotificationService.js';

import { SessionHandler } from './host/handlers/SessionHandler.js';
import { ModelProviderHandler } from './host/handlers/ModelProviderHandler.js';
import { SettingsHandler } from './host/handlers/SettingsHandler.js';
import { FontConfigHandler } from './host/handlers/FontConfigHandler.js';
import { CliModelsHandler } from './host/handlers/CliModelsHandler.js';
import { CliStatusHandler } from './host/handlers/CliStatusHandler.js';
import { ContextHandler } from './host/handlers/ContextHandler.js';
import { WindowEventHandler } from './host/handlers/WindowEventHandler.js';
import { SkillHandler } from './host/handlers/SkillHandler.js';
import { AgentHandler } from './host/handlers/AgentHandler.js';
import { HistoryHandler } from './host/handlers/HistoryHandler.js';
import { FileHandler } from './host/handlers/FileHandler.js';
import { DiffHandler } from './host/handlers/DiffHandler.js';
import { UndoFileHandler } from './host/handlers/UndoFileHandler.js';
import { PermissionHandler } from './host/handlers/PermissionHandler.js';
import { McpServerHandler } from './host/handlers/McpServerHandler.js';
import { McpMarketplaceHandler } from './host/handlers/McpMarketplaceHandler.js';
import { TabHandler } from './host/handlers/TabHandler.js';
import { TokenTrackerHandler } from './host/handlers/TokenTrackerHandler.js';
	import { TabManager } from './host/tabs/TabManager.js';
	import { EditorContextTracker } from './host/context/EditorContextTracker.js';
import { logDiagnostic } from './host/util/DiagnosticLogger.js';

export function activate(context: vscode.ExtensionContext) {
	console.log('[extension] OpenCode X activating...');

	// ── 1. 设置存储 ──────────────────────────────────────────────────────────
	const store = new MementoSettingsStore(context.workspaceState, context.globalState);
	const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
	const settings = new SettingsService(store, workspaceRoots);

	// ── 2. 消息总线 ──────────────────────────────────────────────────────────
	const channel = new BroadcastChannel();
	const handlerContext = new HandlerContext(channel, settings);
	const dispatcher = new MessageDispatcher();

	// ── 3. handlers ──────────────────────────────────────────────────────────
	const permissionHandler = new PermissionHandler(handlerContext);
	dispatcher.registerHandler(new SessionHandler(handlerContext));
	dispatcher.registerHandler(new ModelProviderHandler(handlerContext));
	dispatcher.registerHandler(new SettingsHandler(handlerContext));
	const fontConfigHandler = new FontConfigHandler(handlerContext);
	dispatcher.registerHandler(fontConfigHandler);
	const cliModelsHandler = new CliModelsHandler(handlerContext);
	dispatcher.registerHandler(cliModelsHandler);
	dispatcher.registerHandler(new CliStatusHandler(handlerContext));
	dispatcher.registerHandler(new ContextHandler(handlerContext));
	dispatcher.registerHandler(new WindowEventHandler(handlerContext));
	dispatcher.registerHandler(new SkillHandler(handlerContext));
	dispatcher.registerHandler(new AgentHandler(handlerContext));
	const historyHandler = new HistoryHandler(handlerContext);
	dispatcher.registerHandler(historyHandler);
	dispatcher.registerHandler(new FileHandler(handlerContext));
	dispatcher.registerHandler(new McpServerHandler(handlerContext));
	dispatcher.registerHandler(new McpMarketplaceHandler(handlerContext));
	const diffHandler = new DiffHandler(handlerContext);
	dispatcher.registerHandler(diffHandler);
	dispatcher.registerHandler(new UndoFileHandler(handlerContext));
	dispatcher.registerHandler(permissionHandler);
	dispatcher.registerHandler(new TokenTrackerHandler(handlerContext));

	// ── 4. 常驻 daemon（opencode serve + @opencode-ai/sdk）─────────────────
	const daemonScriptPath = resolveDaemonScript(context.extensionPath);
	const daemon = new OpenCodeDaemonBridge({
		daemonScriptPath,
		// 用户自定义的 opencode TUI 路径（设置页）→ 注入 OPENCODE_BIN，
		// ai-bridge 的 cli-path / serve-manager 解析器会优先使用它。
		additionalEnv: () => {
			const value = store.getGlobal('opencode.tuiPath');
			return typeof value === 'string' && value.trim() !== '' ? { OPENCODE_BIN: value.trim() } : {};
		},
		lifecycleListener: {
			onDaemonReady: () => {
				console.log('[extension] OpenCode daemon ready');
				pushDaemonStatus(channel, true);
			},
			onDaemonDied: () => {
				console.warn('[extension] OpenCode daemon died; will auto-restart');
				pushDaemonStatus(channel, false);
			},
		},
		onLog: (message) => logDiagnostic(message),
	});
	handlerContext.setDaemon(daemon);

	// ── 5. 宿主注入：文件操作 / 兜底工作目录 ─────────────────────────────────
	const fileOps: FileOps = {
		openFile: (path) => {
			if (!path) {
				return;
			}
			void vscode.window.showTextDocument(vscode.Uri.file(path));
		},
		resolveFilePath: (path) => (path && path.trim() !== '' ? path : null),
		openExternal: (url) => {
			try {
				void vscode.env.openExternal(vscode.Uri.parse(url));
			} catch (err) {
				console.warn(`[extension] openExternal failed for ${url}: ${(err as Error).message}`);
			}
		},
		copyToClipboard: (text) => {
			try {
				void vscode.env.clipboard.writeText(text);
				return true;
			} catch (err) {
				console.warn(`[extension] clipboard write failed: ${(err as Error).message}`);
				return false;
			}
		},
	};
	handlerContext.setFileOps(fileOps);

	handlerContext.setFallbackWorkingDirectoryResolver(() => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			return dirname(editor.document.uri.fsPath);
		}
		return null;
	});

	// ── 5b. 编辑器上下文跟踪（当前文件 / 选区 → webview ContextBar）──────────
	const editorContextTracker = new EditorContextTracker(handlerContext);
	editorContextTracker.register();
	context.subscriptions.push({ dispose: () => editorContextTracker.dispose() });
	// 设置关闭（autoOpenFileEnabled=false）时同步清空 tracker 缓存，
	// 避免发送路径读到过期的 @file 上下文。
	handlerContext.setEditorContextClearer(() => editorContextTracker.clear());
	// frontend_ready 时推送当前编辑器上下文（需在 webview JS 就绪后调用）。
	handlerContext.setEditorContextPusher(() => editorContextTracker.updateNow());

	// ── 5c. VS Code 主题变化推送（设置页「跟随 VS Code」选项）───────────────
	const pushIdeTheme = (): void => {
		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		channel.callJavaScript('onIdeThemeChanged', JSON.stringify({ isDark }));
	};
	context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(pushIdeTheme));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('editor.fontFamily')
				|| event.affectsConfiguration('editor.fontSize')
				|| event.affectsConfiguration('editor.lineHeight')) {
				fontConfigHandler.pushInitialConfig();
			}
		}),
	);
	context.subscriptions.push({ dispose: () => diffHandler.dispose() });

	// ── 6. 会话层 ────────────────────────────────────────────────────────────
	const notificationService = new NotificationService(handlerContext);
	const session = new OpenCodeSession({
		context: handlerContext,
		daemon,
		permissionHandler: (request) => permissionHandler.onPermissionRequested(request),
		// 服务端主动关闭/答复未决 prompt（回合中止、超时、其他入口作答）时，
		// 必须回调 webview 移除对应卡片，否则问题卡片会残留在对话列表底部。
		permissionClosedHandler: (kind, content) => permissionHandler.onPromptClosed(kind, content),
		editorSelectionResolver: () => editorContextTracker.getCurrentSelectionInfo(),
		onTurnCompleted: ({ sessionId, title, messageCount, status }) => {
			if (sessionId) {
				historyHandler.recordSession(sessionId, title, messageCount, session.state.getModel() ?? undefined);
			}
			notificationService.onTurnCompleted({ status });
		},
	});
	handlerContext.setSession(session);
	// workspaceState 持久化的模型 / 模式 / 推理力度回灌（frontend_ready 推送恢复）
	const lastSelectedModel = settings.getLastSelectedModel();
	if (lastSelectedModel) {
		session.state.setModel(lastSelectedModel);
	}
	const lastPermissionMode = settings.getLastPermissionMode();
	if (lastPermissionMode) {
		session.state.setPermissionMode(lastPermissionMode);
	}
	const lastReasoningEffort = settings.getLastReasoningEffort();
	if (lastReasoningEffort) {
		session.state.setReasoningEffort(lastReasoningEffort);
	}
	context.subscriptions.push({ dispose: () => session.dispose() });

	// ── 6b. 多标签页管理（create_new_tab → 新原生编辑器 tab + 独立会话）──────
	const tabManager = new TabManager({
		extensionUri: context.extensionUri,
		settings,
		settingsStore: store,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver: () => {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.uri.scheme === 'file') {
				return dirname(editor.document.uri.fsPath);
			}
			return null;
		},
		onLog: (message) => logDiagnostic(message),
	});
	dispatcher.registerHandler(new TabHandler(handlerContext, tabManager));
	context.subscriptions.push({ dispose: () => tabManager.disposeAll() });

	// ── 7. 双面板 provider（共享 session / daemon / handlers）────────────────
	const leftProvider = new OpenCodeViewProvider({
		extensionUri: context.extensionUri,
		host: 'left',
		channel,
		dispatcher,
		// 首帧主题/偏好由宿主注入，避免浅色主题下先闪一帧暗色。
		getUiPreferences: () => settings.getUiPreferences(),
		onReady: () => {
			fontConfigHandler.pushInitialConfig();
		},
	});
	const rightProvider = new OpenCodeViewProvider({
		extensionUri: context.extensionUri,
		host: 'right',
		channel,
		dispatcher,
		// 首帧主题/偏好由宿主注入，避免浅色主题下先闪一帧暗色。
		getUiPreferences: () => settings.getUiPreferences(),
		onReady: () => {
			fontConfigHandler.pushInitialConfig();
		},
	});

	// 编辑器区域的「分栏对话窗口」宿主：与左右侧边栏共享同一份 bundle、
	// BroadcastChannel 与 MessageDispatcher，因此看到的是同一个会话。
	const editorPanel = new OpenCodeEditorPanel({
		extensionUri: context.extensionUri,
		channel,
		dispatcher,
		// 首帧主题/偏好由宿主注入，避免浅色主题下先闪一帧暗色。
		getUiPreferences: () => settings.getUiPreferences(),
		onReady: () => {
			fontConfigHandler.pushInitialConfig();
		},
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('opencode-gui.left', leftProvider),
		vscode.window.registerWebviewViewProvider('opencode-gui.right', rightProvider),
		vscode.commands.registerCommand('opencode-gui.openLeft', () =>
			vscode.commands.executeCommand('workbench.view.extension.opencode-gui'),
		),
		vscode.commands.registerCommand('opencode-gui.openChat', () => {
			// 在编辑器区域分栏打开 OpenCode（ViewColumn.Beside），与左/右侧边栏无关。
			// 说明：原先这里用 `opencode-gui.right.focus` 聚焦副侧边栏，但该命令只聚焦
			// 已可见的视图、不会展开隐藏的次要侧边栏，且不抛异常，导致点击后毫无反应。
			editorPanel.open();
		}),
		{ dispose: () => channel.detachAll() },
	);

	// ── 8. daemon 预热（不阻塞 activate；失败仅告警，不影响插件可用）─────────
	void warmupDaemon(daemon, handlerContext, settings, cliModelsHandler)
		.catch((err) => console.warn(`[extension] Daemon warmup failed: ${(err as Error).message}`));

	console.log('[extension] OpenCode X activated');
}

/** 常驻 daemon 启动 + `opencode.preconnect` 预热 serve。 */
async function warmupDaemon(
	daemon: OpenCodeDaemonBridge,
	context: HandlerContext,
	settings: SettingsService,
	cliModelsHandler: CliModelsHandler,
): Promise<void> {
	const started = await daemon.start();
	if (!started) {
		console.warn('[extension] OpenCode daemon failed to start');
		return;
	}
	const cwd = context.resolveEffectiveWorkingDirectory() ?? settings.getPrimaryWorkspaceRoot() ?? undefined;

	// preconnect 与模型缓存现在并发下发：daemon 的共享通道允许多个只读/准备
	// 命令并行，避免 getModels 排队等待 cold serve 启动。
	await Promise.all([
		daemon.request(
			'opencode.preconnect',
			{ cwd: cwd ?? undefined },
			{
				onLine: () => {},
				onError: (error) => console.warn(`[extension] opencode.preconnect failed: ${error}`),
				onComplete: () => console.log('[extension] opencode preconnect complete (serve warm)'),
			},
		),
		cliModelsHandler.warmCache(),
	]);
	console.log('[extension] OpenCode preconnect and model catalog cache warm');
}

/** 解析 daemon 脚本：优先打包产物，否则回退到源码 ESM。 */
function resolveDaemonScript(extensionPath: string): string {
	const bundled = join(extensionPath, 'dist', 'ai-bridge.js');
	if (existsSync(bundled)) {
		return bundled;
	}
	return join(extensionPath, 'ai-bridge', 'daemon.js');
}

function pushDaemonStatus(channel: BroadcastChannel, alive: boolean): void {
	channel.postRaw({
		type: 'updateDaemonStatus',
		args: [JSON.stringify({ alive })],
	});
}

export function deactivate() {
	console.log('[extension] OpenCode X deactivating...');
}
