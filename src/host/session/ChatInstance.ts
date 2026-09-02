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
import { NotificationService } from '../notifications/NotificationService';

/**
 * 启动时把 workspaceState 里持久化的模型 / 权限模式 / 推理力度回灌
 * SessionState——frontend_ready 经 applyBackendTabState 推给 webview 恢复。
 */
function seedSessionFromPersistedSelection(settings: SettingsService, session: OpenCodeSession): void {
	const lastModel = settings.getLastSelectedModel();
	if (lastModel) {
		session.state.setModel(lastModel);
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

export interface ChatInstanceDeps {
	channel: WebviewChannel;
	settings: SettingsService;
	daemon: OpenCodeDaemonBridge;
	fileOps: FileOps;
	fallbackWorkingDirectoryResolver: () => string | null;
}

export interface ChatInstance {
	context: HandlerContext;
	dispatcher: MessageDispatcher;
	session: OpenCodeSession;
	historyHandler: HistoryHandler;
	permissionHandler: PermissionHandler;
	dispose(): void;
}

export function createChatInstance(deps: ChatInstanceDeps): ChatInstance {
	const context = new HandlerContext(deps.channel, deps.settings);
	context.setDaemon(deps.daemon);
	context.setFileOps(deps.fileOps);
	context.setFallbackWorkingDirectoryResolver(deps.fallbackWorkingDirectoryResolver);

	const dispatcher = new MessageDispatcher();
	const permissionHandler = new PermissionHandler(context);
	dispatcher.registerHandler(new SessionHandler(context));
	dispatcher.registerHandler(new ModelProviderHandler(context));
	dispatcher.registerHandler(new SettingsHandler(context));
	dispatcher.registerHandler(new CliModelsHandler(context));
	dispatcher.registerHandler(new CliStatusHandler(context));
	dispatcher.registerHandler(new ContextHandler(context));
	dispatcher.registerHandler(new WindowEventHandler(context));
	dispatcher.registerHandler(new SkillHandler(context));
	dispatcher.registerHandler(new AgentHandler(context));
	const historyHandler = new HistoryHandler(context);
	dispatcher.registerHandler(historyHandler);
	dispatcher.registerHandler(new FileHandler(context));
	dispatcher.registerHandler(new McpServerHandler(context));
	dispatcher.registerHandler(new McpMarketplaceHandler(context));
	dispatcher.registerHandler(new DiffHandler(context));
	dispatcher.registerHandler(new UndoFileHandler(context));
	dispatcher.registerHandler(permissionHandler);
	dispatcher.registerHandler(new TokenTrackerHandler(context));

	const notificationService = new NotificationService(context);
	const session = new OpenCodeSession({
		context,
		daemon: deps.daemon,
		permissionHandler: (request) => permissionHandler.onPermissionRequested(request),
		permissionClosedHandler: (kind, content) => permissionHandler.onPromptClosed(kind, content),
		onTurnCompleted: (info: TurnCompletedInfo) => {
			if (info.sessionId) {
				historyHandler.recordSession(info.sessionId, info.title, info.messageCount, session.state.getModel() ?? undefined);
			}
			notificationService.onTurnCompleted(info);
		},
	});
	context.setSession(session);
	seedSessionFromPersistedSelection(deps.settings, session);

	return {
		context,
		dispatcher,
		session,
		historyHandler,
		permissionHandler,
		dispose: () => session.dispose(),
	};
}
