/**
 * ChatInstance — 一组完整可用的「聊天实例」：视图通道 → HandlerContext →
 * dispatcher → handlers → OpenCodeSession。
 *
 * 一个扩展进程只有一个实例：侧边栏左/右、每个编辑器 panel 都是它的挂载点
 * （`attachView`）。会话、标签、模型与模式因此全局唯一，所有视图显示同一份
 * 内容；关闭视图只解绑，不销毁实例。
 */
import { HandlerContext, FileOps } from '../router/HandlerContext';
import { MessageDispatcher } from '../router/MessageDispatcher';
import { ViewRegistry, type ViewAttachment } from '../router/ViewRegistry';
import { SettingsService } from '../settings/SettingsService';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { SessionManager } from './SessionManager';
import { NotificationService } from '../notifications/NotificationService';

/**
 * 启动时把 workspaceState 里持久化的模型 / 权限模式 / 推理力度回灌
 * SessionState——frontend_ready 经 applyBackendTabState 推给 webview 恢复。
 */
function seedSessionFromPersistedSelection(settings: SettingsService, session: OpenCodeSession): void {
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
import { FileHandler } from '../handlers/FileHandler';
import { DiffHandler } from '../handlers/DiffHandler';
import { UndoFileHandler } from '../handlers/UndoFileHandler';
import { McpServerHandler } from '../handlers/McpServerHandler';
import { McpMarketplaceHandler } from '../handlers/McpMarketplaceHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { TokenTrackerHandler } from '../handlers/TokenTrackerHandler';
import { ExportHandler } from '../handlers/ExportHandler';
import type { EditorContextTracker } from '../context/EditorContextTracker';

export interface ChatInstanceDeps {
	settings: SettingsService;
	daemon: OpenCodeDaemonBridge;
	fileOps: FileOps;
	fallbackWorkingDirectoryResolver: () => string | null;
	editorContextTracker?: EditorContextTracker;
	/** 把某个会话带到前台（reveal panel + 切视图内标签）；没有对应 panel 时返回 false。 */
	revealSession?: (sessionId: string) => boolean;
}

export interface ChatInstance {
	context: HandlerContext;
	dispatcher: MessageDispatcher;
	session: OpenCodeSession;
	sessionManager: SessionManager;
	historyHandler: HistoryHandler;
	permissionHandler: PermissionHandler;
	fontConfigHandler: FontConfigHandler;
	/** 挂载一个视图（侧边栏 / 编辑器面板），返回解绑函数。 */
	attachView(view: ViewAttachment): () => void;
	/** 解绑视图；实例本身继续存活。 */
	detachView(viewId: string): void;
	/** 已挂载视图数量。 */
	getViewCount(): number;
	/** 已就绪（发过 `frontend_ready`）的视图 id。 */
	getReadyViewIds(): string[];
	/** 订阅「某个视图首次就绪」；返回取消订阅函数。 */
	onViewReady(listener: (viewId: string) => void): () => void;
	/** 视图发起的消息：带上来源，供「只回给发起者」的推送使用。 */
	dispatchFrom(viewId: string, type: string, content: string): boolean;
	dispose(): void;
}

export function createChatInstance(deps: ChatInstanceDeps): ChatInstance {
	const views = new ViewRegistry();
	const context = new HandlerContext(views, deps.settings);
	context.setViewSender((viewId, fn, ...args) => views.callJavaScriptTo(viewId, fn, ...args));
	context.setViewReadyMarker((viewId) => views.markReady(viewId));
	context.setDaemon(deps.daemon);
	context.setFileOps(deps.fileOps);
	context.setFallbackWorkingDirectoryResolver(deps.fallbackWorkingDirectoryResolver);
	context.setSessionFocuser(deps.revealSession ?? null);

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
	dispatcher.registerHandler(new AgentHandler(context));
	const historyHandler = new HistoryHandler(context);
	dispatcher.registerHandler(historyHandler);
	dispatcher.registerHandler(new ExportHandler(context));
	dispatcher.registerHandler(new FileHandler(context));
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
		// tab 内开关文件上下文：只回推给发起该操作的那个视图。
		// 全局设置不参与这里的判断——它只决定新 tab 的初始状态。
		context.setEditorContextRefresher((enabled) => {
			if (!enabled) {
				context.callJavaScriptToOrigin('clearSelectionInfo');
				return;
			}
			tracker.pushTo((info) => {
				if (info) {
					context.callJavaScriptToOrigin('addSelectionInfo', info);
				} else {
					context.callJavaScriptToOrigin('clearSelectionInfo');
				}
			});
		});
	}
	context.setFontConfigPusher(() => fontConfigHandler.pushInitialConfig());

	const notificationService = new NotificationService(context);
	const sessionManager = new SessionManager({
		context,
		daemon: deps.daemon,
		permissionHandler: (request) => permissionHandler.onPermissionRequested(request),
		permissionClosedHandler: (kind, content) => permissionHandler.onPromptClosed(kind, content),
		clearSessionHandler: (sessionId: string) => permissionHandler.clearSession(sessionId),
		editorSelectionResolver: () => deps.editorContextTracker?.getCurrentSelectionInfo() ?? null,
		onTurnCompleted: (info: TurnCompletedInfo) => {
			// 后台会话结束时 `getActiveSession()` 指向的是**前台**会话，用它取 model
			// 会把 A 的模型记到 B 的历史摘要上。先按 sessionId 精确定位。
			const completed = (info.sessionId ? sessionManager.getSession(info.sessionId) : null)
				?? sessionManager.getActiveSession();
			if (info.sessionId) {
				historyHandler.recordSession(info.sessionId, info.title, info.messageCount, completed.state.getModel() ?? undefined);
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
		attachView: (view) => {
			const detach = views.attach(view);
			return () => {
				detach();
			};
		},
		detachView: (viewId) => views.detach(viewId),
		getViewCount: () => views.size(),
		getReadyViewIds: () => views.readyIds(),
		onViewReady: (listener) => views.onReady(listener),
		dispatchFrom: (viewId, type, content) => {
			const previous = context.getDispatchOrigin();
			context.setDispatchOrigin(viewId);
			try {
				return dispatcher.dispatch(type, content);
			} finally {
				context.setDispatchOrigin(previous);
			}
		},
		dispose: () => sessionManager.dispose(),
	};
}
