/**
 * ChatInstance — 一组完整可用的「聊天实例」：channel → HandlerContext →
 * dispatcher → handlers → OpenCodeSession，对应 cc-gui 每个 tab 一个
 * `ClaudeChatWindow` 的装配。
 *
 * 左/右面板共享一个实例（BroadcastChannel）；「新建标签页」每开一个新
 * WebviewPanel 就用本工厂再建一个独立实例（独立会话）。
 */
import { WebviewChannel, HandlerContext, FileOps } from '../router/HandlerContext';
import { MessageDispatcher } from '../router/MessageDispatcher';
import { SettingsService } from '../settings/SettingsService';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { SessionManager } from './SessionManager';
import type { JsTarget } from './SessionCallbackAdapter';
import type { PromptRegistry } from '../prompt/PromptRegistry';
import { NotificationService } from '../notifications/NotificationService';

/**
 * 启动时把 workspaceState 里持久化的模型 / 权限模式 / 推理力度回灌
 * SessionState——frontend_ready 经 applyBackendTabState 推给 webview 恢复。
 *
 * 多 tab 装配下同样用于每个新 tab 的初始会话：新 tab 继承上次的选择，
 * 之后各 tab 的改动互不影响。
 */
export function seedSessionFromPersistedSelection(settings: SettingsService, session: OpenCodeSession): void {
	const pinned = settings.getPinnedModels()['opencode'];
	const firstPinned = Array.isArray(pinned) && pinned.length > 0 ? pinned[0] : null;
	const lastModel = settings.getLastSelectedModel();
	const initialModel = firstPinned || lastModel;
	if (initialModel) {
		session.state.setModel(initialModel);
	}
	const lastMode = settings.getLastPermissionMode();
	if (lastMode) {
		session.state.setPermissionMode(lastMode);
	}
	const lastEffort = settings.getLastReasoningEffort();
	if (lastEffort) {
		session.state.setReasoningEffort(lastEffort);
	}
}

import { SessionHandler } from '../handlers/SessionHandler';
import { FontConfigHandler } from '../handlers/FontConfigHandler';
import { ModelProviderHandler } from '../handlers/ModelProviderHandler';
import { SettingsHandler } from '../handlers/SettingsHandler';
import { CliModelsHandler } from '../handlers/CliModelsHandler';
import { CliStatusHandler } from '../handlers/CliStatusHandler';
import { ContextHandler } from '../handlers/ContextHandler';
import { WindowEventHandler } from '../handlers/WindowEventHandler';
import { SkillHandler } from '../handlers/SkillHandler';
import { AgentHandler } from '../handlers/AgentHandler';
import { HistoryHandler } from '../handlers/HistoryHandler';
import { FileHandler, type FileEntry } from '../handlers/FileHandler';
import { DiffHandler } from '../handlers/DiffHandler';
import { UndoFileHandler } from '../handlers/UndoFileHandler';
import { McpServerHandler } from '../handlers/McpServerHandler';
import { McpMarketplaceHandler } from '../handlers/McpMarketplaceHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { TokenTrackerHandler } from '../handlers/TokenTrackerHandler';
import { ExportHandler } from '../handlers/ExportHandler';
import type { EditorContextTracker } from '../context/EditorContextTracker';

export interface ChatInstanceDeps {
	channel: WebviewChannel;
	settings: SettingsService;
	daemon: OpenCodeDaemonBridge;
	fileOps: FileOps;
	fallbackWorkingDirectoryResolver: () => string | null;
	editorContextTracker?: EditorContextTracker;
}

export interface ChatInstance {
	context: HandlerContext;
	dispatcher: MessageDispatcher;
	session: OpenCodeSession;
	sessionManager: SessionManager;
	historyHandler: HistoryHandler;
	permissionHandler: PermissionHandler;
	fontConfigHandler: FontConfigHandler;
	/**
	 * 创建一个会话实例（多 tab：每个 tab 一个），输出经 `viewSink` 归属到该 tab。
	 *
	 * 依赖（daemon / 权限回调 / 回合完成回调 / 编辑器选区解析）全部来自本实例，
	 * 所以 tab 会话与 legacy 单会话共享同一套宿主依赖。
	 */
	createSession(
		viewSink?: JsTarget,
		autoOpenFileEnabledResolver?: () => boolean | null | undefined,
	): OpenCodeSession;
	/** 把某个历史会话加载进活跃 tab（v2 `session.load`）。 */
	loadSessionById(sessionId: string): void;
	/** 重新向 daemon 枚举 agent 目录并推送（v2 `agents.list`）。 */
	refreshAgents(): void;
	/**
	 * 接入窗口级 PromptRegistry（未决弹窗的 tab 归属 + 关 tab 时拒绝）。
	 * 会话层先建、ChatWindow 后建，所以只能后注入。
	 */
	attachPromptRegistry(
		registry: PromptRegistry,
		resolveTabId: (sessionId: string | null) => string | null,
	): void;
	/** 关 tab 时拒绝这些未决 prompt（deny / rejectQuestion）。 */
	rejectPrompts(requestIds: string[]): void;
	/** 把文本存到用户选定文件（v2 `save_json`）。 */
	saveText(content: string, filename: string): Promise<boolean>;
	/** 列举候选文件（v2 `files.list`）：目录由宿主按目标 tab 的 cwd 给出。 */
	listFiles(query: string, directory: string | undefined): Promise<FileEntry[]>;
	/**
	 * 接上语义事件发布器（`files.undo` 等按 tab 投递）。
	 * 会话层先建、ChatWindow 后建，只能后注入。
	 */
	setEventPublisher(
		publisher: (type: string, tabId: string, payload: Record<string, unknown>) => void,
	): void;
	dispose(): void;
}

export function createChatInstance(deps: ChatInstanceDeps): ChatInstance {
	const context = new HandlerContext(deps.channel, deps.settings);
	context.setDaemon(deps.daemon);
	context.setFileOps(deps.fileOps);
	context.setFallbackWorkingDirectoryResolver(deps.fallbackWorkingDirectoryResolver);

	const dispatcher = new MessageDispatcher();
	const permissionHandler = new PermissionHandler(context);
	const fontConfigHandler = new FontConfigHandler(context);
	dispatcher.registerHandler(new SessionHandler(context));
	dispatcher.registerHandler(new ModelProviderHandler(context));
	dispatcher.registerHandler(new SettingsHandler(context));
	dispatcher.registerHandler(fontConfigHandler);
	dispatcher.registerHandler(new CliModelsHandler(context));
	dispatcher.registerHandler(new CliStatusHandler(context));
	dispatcher.registerHandler(new ContextHandler(context));
	dispatcher.registerHandler(new WindowEventHandler(context));
	dispatcher.registerHandler(new SkillHandler(context));
	const agentHandler = new AgentHandler(context);
	dispatcher.registerHandler(agentHandler);
	const historyHandler = new HistoryHandler(context);
	dispatcher.registerHandler(historyHandler);
	const exportHandler = new ExportHandler(context);
	dispatcher.registerHandler(exportHandler);
	const fileHandler = new FileHandler(context);
	dispatcher.registerHandler(fileHandler);
	dispatcher.registerHandler(new McpServerHandler(context));
	dispatcher.registerHandler(new McpMarketplaceHandler(context));
	dispatcher.registerHandler(new DiffHandler(context));
	dispatcher.registerHandler(new UndoFileHandler(context));
	dispatcher.registerHandler(permissionHandler);
	dispatcher.registerHandler(new TokenTrackerHandler(context));

	if (deps.editorContextTracker) {
		const tracker = deps.editorContextTracker;
		context.setEditorContextClearer(() => tracker.clear());
		context.setEditorContextPusher(() => tracker.updateNow());
	}
	context.setFontConfigPusher(() => fontConfigHandler.pushInitialConfig());

	const notificationService = new NotificationService(context);
	const sessionManager = new SessionManager({
		context,
		daemon: deps.daemon,
		permissionHandler: (request) => permissionHandler.onPermissionRequested(request),
		permissionClosedHandler: (kind, content) => permissionHandler.onPromptClosed(kind, content),
		editorSelectionResolver: () => deps.editorContextTracker?.getCurrentSelectionInfo() ?? null,
		onTurnCompleted: (info: TurnCompletedInfo) => {
			// 回合可能发生在后台 tab：model 要取**完成该回合的会话**，
			// 不能取「当前活跃会话」（会把 B 的模型记到 A 的历史条目上）。
			const completed = sessionManager.findSession(info.sessionId);
			const model = (completed ?? sessionManager.getActiveSession()).state.getModel() ?? undefined;
			if (info.sessionId) {
				historyHandler.recordSession(info.sessionId, info.title, info.messageCount, model);
			}
			notificationService.onTurnCompleted(info);
		},
		onSessionCreated: (newSession) => {
			seedSessionFromPersistedSelection(deps.settings, newSession);
		},
	});
	context.setSessionManager(sessionManager);
	context.setSession(sessionManager.getActiveSession());
	seedSessionFromPersistedSelection(deps.settings, sessionManager.getActiveSession());

	return {
		context,
		dispatcher,
		session: sessionManager.getActiveSession(),
		sessionManager,
		historyHandler,
		permissionHandler,
		fontConfigHandler,
		createSession: (viewSink, autoOpenFileEnabledResolver) =>
			sessionManager.createSessionInstance({ viewSink, autoOpenFileEnabledResolver }),
		loadSessionById: (sessionId) => historyHandler.loadSessionById(sessionId),
		refreshAgents: () => agentHandler.refresh(),
		attachPromptRegistry: (registry, resolveTabId) => {
			permissionHandler.attachPromptRegistry(registry, resolveTabId);
		},
		rejectPrompts: (requestIds) => permissionHandler.rejectPrompts(requestIds),
		saveText: (content, filename) => exportHandler.saveText(content, filename),
		listFiles: (query, directory) => fileHandler.listFiles(query, directory),
		setEventPublisher: (publisher) => context.setEventPublisher(publisher),
		dispose: () => sessionManager.dispose(),
	};
}
