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

import { OpenCodeViewProvider } from './host/webview/OpenCodeViewProvider.js';
import { FileOps } from './host/router/HandlerContext.js';
import { OpenCodeDaemonBridge } from './host/provider/OpenCodeDaemonBridge.js';
import { MementoSettingsStore, SettingsService } from './host/settings/SettingsService.js';
import { WebviewBroadcaster } from './host/router/WebviewBroadcaster.js';
import { BroadcastWebviewChannel } from './host/webview/BroadcastWebviewChannel.js';
import { TabManager } from './host/tabs/TabManager.js';
import { EditorContextTracker } from './host/context/EditorContextTracker.js';
import { logDiagnostic, logError, setDiagnosticVerbose } from './host/util/DiagnosticLogger.js';
import { ChatWindow } from './host/window/ChatWindow.js';
import { createChatInstance, seedSessionFromPersistedSelection } from './host/session/ChatInstance.js';
import { TabHandler } from './host/handlers/TabHandler.js';

export function activate(context: vscode.ExtensionContext) {
	// ── 0a. 生产包 console 降级：只保留 error 级 ─────────────────────────────
	// 构建级别由 esbuild define 注入（package → production，compile/watch →
	// development）。生产包丢弃 log/info/debug/warn——它们既刷 Debug Console
	// 也被各处无界调用；console.error 保留，错误仍然可见。
	if (process.env.NODE_ENV === 'production') {
		const noop = (): void => undefined;
		console.log = noop;
		console.info = noop;
		console.debug = noop;
		console.warn = noop;
	}

	console.log('[extension] OpenCode activating...');

	// ── 0. 诊断日志开关（OutputChannel 常驻内存，高频日志默认关闭）────────────
	const readVerboseDiagnostics = (): boolean =>
		vscode.workspace.getConfiguration('openCodeBuddy').get<boolean>('verboseDiagnostics', false);
	setDiagnosticVerbose(readVerboseDiagnostics());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('openCodeBuddy.verboseDiagnostics')) {
				setDiagnosticVerbose(readVerboseDiagnostics());
			}
		}),
	);

	// ── 1. 设置存储 ──────────────────────────────────────────────────────────
	const store = new MementoSettingsStore(context.workspaceState, context.globalState);
	const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
	const settings = new SettingsService(store, workspaceRoots);

	// ── 2. 常驻 daemon（opencode serve + @opencode-ai/sdk）─────────────────
	const daemonScriptPath = resolveDaemonScript(context.extensionPath);
	// daemon 在 ChatWindow 之前创建；onDaemonDied 需要回调到窗口级状态清理。
	let chatWindowRef: ChatWindow | null = null;
	const daemon = new OpenCodeDaemonBridge({
		daemonScriptPath,
		// 用户自定义的 opencode TUI 路径（设置页）→ 注入 OPENCODE_BIN，
		// ai-bridge 的 cli-path / serve-manager 解析器会优先使用它。
		additionalEnv: () => {
			const value = store.getGlobal('opencode.tuiPath');
			const cliPath = typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
			const configDir = context.globalStorageUri?.fsPath;
			return {
				...(cliPath ? { OPENCODEBUDDY_CLI_PATH: cliPath, OPENCODE_BIN: cliPath } : {}),
				OPENCODEBUDDY_NODE_BIN: process.execPath,
				...(configDir ? { OPENCODEBUDDY_CONFIG_DIR: configDir } : {}),
				// 生产包只保留 error 级：daemon 据此丢弃 [DEBUG] stderr 噪音
				//（否则每条 stderr 都会被宿主桥接转发）。
				...(process.env.NODE_ENV === 'production' ? { AI_BRIDGE_LOG_LEVEL: 'error' } : {}),
			};
		},
		lifecycleListener: {
			onDaemonReady: () => {
				console.log('[extension] OpenCode daemon ready');
				WebviewBroadcaster.broadcastJavaScript('onDaemonStatusChanged', 'true');
			},
			onDaemonDied: () => {
				// error 级：daemon 意外死亡与自动重启在生产包也必须可见
				logError('OpenCode daemon died; will auto-restart');
				WebviewBroadcaster.broadcastJavaScript('onDaemonStatusChanged', 'false');
				chatWindowRef?.handleDaemonDied();
			},
		},
		onLog: (message) => logDiagnostic(message),
	});

	// ── 3. 宿主注入：文件操作 / 兜底工作目录 ─────────────────────────────────
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

	const fallbackWorkingDirectoryResolver = (): string | null => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			return dirname(editor.document.uri.fsPath);
		}
		return null;
	};

	// ── 4. 编辑器上下文跟踪（当前文件 / 选区 → webview ContextBar）──────────
	const editorContextTracker = new EditorContextTracker(settings);
	editorContextTracker.register();
	context.subscriptions.push({ dispose: () => editorContextTracker.dispose() });

	// ── 5. VS Code 主题与字体变化广播（设置页「跟随 VS Code」选项）─────────
	const pushIdeTheme = (): void => {
		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		WebviewBroadcaster.broadcastJavaScript('onIdeThemeChanged', JSON.stringify({ isDark }));
	};
	context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(pushIdeTheme));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('editor.fontFamily')
				|| event.affectsConfiguration('editor.fontSize')
				|| event.affectsConfiguration('editor.lineHeight')) {
				WebviewBroadcaster.broadcastJavaScript('onFontConfigChanged');
			}
		}),
	);

	// ── 5b. 全局单例：一个 ChatInstance + 一个 ChatWindow（单实例多视图）────────
	// 会话归 tab 所有：所有视图（左右侧边栏 + 编辑器 panel）共享同一个实例，
	// 每个 tab 的会话输出带 tab 身份，经 TabEventRouter 广播并由各视图按 tab 路由。
	const instance = createChatInstance({
		channel: new BroadcastWebviewChannel(),
		settings,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver,
		editorContextTracker,
	});

	const chatWindow = new ChatWindow({
		settings,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver,
		createSession: (viewSink, autoOpenFileEnabledResolver, contextEnabledResolver, eventSink) =>
			instance.createSession(viewSink, autoOpenFileEnabledResolver, contextEnabledResolver, eventSink),
		configureSession: (session) => seedSessionFromPersistedSelection(settings, session),
		onSessionBound: (tabId, sessionId) => {
			logDiagnostic(`[Session] tab=${tabId} bound to session=${sessionId}`);
		},
		loadSession: (sessionId) => instance.loadSessionById(sessionId),
		// 附件按 tab 落在扩展的 globalStorage 下，关 tab 时释放（临时文件不跨会话留存）。
		attachmentsRoot: context.globalStorageUri
			? join(context.globalStorageUri.fsPath, 'attachments')
			: null,
		requestAgents: () => instance.refreshAgents(),
		// 关 tab 时把它的未决权限/提问拒掉，别让服务端一直等。
		onPromptsRejected: (requestIds) => instance.rejectPrompts(requestIds),
		saveText: (content, filename) => {
			void instance.saveText(content, filename);
		},
		// @ 文件候选：目录由宿主按目标 tab 的 cwd 给出（多 tab 各按各的目录）。
		listFiles: (query, directory) => instance.listFiles(query, directory),
		// 子代理 transcript（v2 `subagent.history`）：复用 HistoryHandler 的提取逻辑。
		loadSubagentHistory: (payload) => instance.loadSubagentHistory(payload),
	});
	chatWindowRef = chatWindow;
	// 让 handlers 的 `context.getSession()` 解析到活跃 tab 自己的会话。
	chatWindow.bindSessionManager(instance.sessionManager);
	// 语义事件按 tab 投递（files.undo 等）：结果回到发起请求的那个 tab。
	instance.setEventPublisher((type, tabId, payload) => {
		chatWindow.publishTabEvent(type, tabId, payload);
	});
	// 未决弹窗的 tab 归属：关 tab 时按 tab 拒绝（会话层先建，只能后注入）。
	instance.attachPromptRegistry(
		chatWindow.promptRegistry,
		(sessionId) => chatWindow.resolveTabIdForSession(sessionId),
	);

	// ── 6. 多标签页管理（openChat → 新原生编辑器 tab 作为 View 注册）──────────
	const tabManager = new TabManager({
		extensionUri: context.extensionUri,
		settings,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver,
		chatWindow,
		instance,
		editorContextTracker,
		onLog: (message) => logDiagnostic(message),
	});
	context.subscriptions.push({ dispose: () => tabManager.disposeAll() });
	// legacy `create_new_tab`（视图内"新建对话"按钮）在共享 dispatcher 上注册一次。
	instance.dispatcher.registerHandler(new TabHandler(instance.context, tabManager));

	// ── 7. 双侧边栏 provider（单实例多视图镜像，共享 TabRegistry 与会话）─────
	const leftProvider = new OpenCodeViewProvider({
		extensionUri: context.extensionUri,
		host: 'left',
		settings,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver,
		chatWindow,
		instance,
		editorContextTracker,
		tabManager,
		getUiPreferences: () => settings.getUiPreferences(),
	});
	const rightProvider = new OpenCodeViewProvider({
		extensionUri: context.extensionUri,
		host: 'right',
		settings,
		daemon,
		fileOps,
		fallbackWorkingDirectoryResolver,
		chatWindow,
		instance,
		editorContextTracker,
		tabManager,
		getUiPreferences: () => settings.getUiPreferences(),
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('opencode-buddy.left', leftProvider),
		vscode.window.registerWebviewViewProvider('opencode-buddy.right', rightProvider),
		vscode.commands.registerCommand('opencode-buddy.openLeft', () =>
			vscode.commands.executeCommand('workbench.view.extension.opencode-buddy'),
		),
		vscode.commands.registerCommand('opencode-buddy.openChat', () => {
			// 在编辑器区域新建一个独立的 OpenCode Buddy 对话标签页
			tabManager.openNewTab();
		}),
		{
			dispose: () => {
				leftProvider.dispose();
				rightProvider.dispose();
				instance.dispose();
			},
		},
	);

	// ── 8. daemon 预热（不阻塞 activate；失败仅告警，不影响插件可用）─────────
	void warmupDaemon(daemon, settings)
		.catch((err) => console.warn(`[extension] Daemon warmup failed: ${(err as Error).message}`));

	console.log('[extension] OpenCode activated');
}

/** 常驻 daemon 启动 + `opencode.preconnect` 预热 serve。 */
async function warmupDaemon(
	daemon: OpenCodeDaemonBridge,
	settings: SettingsService,
): Promise<void> {
	const started = await daemon.start();
	if (!started) {
		console.warn('[extension] OpenCode daemon failed to start');
		return;
	}
	const cwd = settings.getPrimaryWorkspaceRoot() ?? undefined;

	// 启动时预热 serve 连接
	await daemon.request(
		'opencode.preconnect',
		{ cwd: cwd ?? undefined },
		{
			onLine: () => {},
			onError: (err) => console.warn(`[extension] Warmup preconnect failed: ${err}`),
			onComplete: () => {},
		},
	);
	console.log('[extension] OpenCode preconnect ready');
}

/** 解析 daemon 脚本：优先环境变量本地调试目录，次优先已安装的 opencode-buddy-core 依赖，次优先打包产物，最后回退到源码 ESM。 */
function resolveDaemonScript(extensionPath: string): string {
	const devBridgePath = process.env.OPENCODE_DEV_BRIDGE_PATH || process.env.OPENCODE_BRIDGE_PATH;
	if (devBridgePath) {
		const devDaemon = join(devBridgePath, 'daemon.js');
		if (existsSync(devDaemon)) {
			console.log(`[extension] Using dev bridge path from env: ${devDaemon}`);
			return devDaemon;
		}
	}
	try {
		const installedDaemon = require.resolve('opencode-buddy-core/daemon.js', { paths: [extensionPath] });
		if (existsSync(installedDaemon)) {
			return installedDaemon;
		}
	} catch {
		// Not installed via standard package resolution, check node_modules directly
		const directNodeModules = join(extensionPath, 'node_modules', 'opencode-buddy-core', 'daemon.js');
		if (existsSync(directNodeModules)) {
			return directNodeModules;
		}
	}
	const bundledCore = join(extensionPath, 'dist', 'opencode-buddy-core', 'daemon.js');
	if (existsSync(bundledCore)) {
		return bundledCore;
	}
	const bundled = join(extensionPath, 'dist', 'ai-bridge.js');
	if (existsSync(bundled)) {
		return bundled;
	}
	throw new Error(
		"opencode-buddy-core daemon.js not found. Please ensure dependencies are installed via 'pnpm install' or OPENCODE_DEV_BRIDGE_PATH is configured.",
	);
}

function pushDaemonStatus(_channel: BroadcastChannel, alive: boolean): void {
	WebviewBroadcaster.broadcastRaw({
		type: 'updateDaemonStatus',
		args: [JSON.stringify({ alive })],
	});
}

export function deactivate() {
	console.log('[extension] OpenCode deactivating...');
}
