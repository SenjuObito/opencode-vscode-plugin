import { HandlerContext } from '../router/HandlerContext';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { PermissionRequest } from './types';

export interface SessionManagerOptions {
	context: HandlerContext;
	daemon: OpenCodeDaemonBridge;
	permissionHandler?: (request: PermissionRequest) => void;
	permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	editorSelectionResolver?: () => string | null;
	onTurnCompleted?: (info: TurnCompletedInfo) => void;
	onSessionCreated?: (session: OpenCodeSession) => void;
}

/**
 * SessionManager — 宿主侧会话生命周期管理器。
 *
 * 架构职责：
 * 1. 托管当前激活会话（activeSession）。
 * 2. 创建新会话或切换会话时，忙碌的旧会话一律精准中断（abort）并释放，不保留后台执行。
 * 3. 严格限制中断（interrupt）作用域，永远只针对目标会话下发精准 abort，禁止全局误杀。
 */
export class SessionManager {
	private activeSession: OpenCodeSession;
	private readonly options: SessionManagerOptions;

	constructor(options: SessionManagerOptions) {
		this.options = options;
		this.activeSession = this.createSessionInstance();
		this.options.onSessionCreated?.(this.activeSession);
	}

	getActiveSession(): OpenCodeSession {
		return this.activeSession;
	}

	createSessionInstance(): OpenCodeSession {
		const session = new OpenCodeSession({
			context: this.options.context,
			daemon: this.options.daemon,
			permissionHandler: this.options.permissionHandler,
			permissionClosedHandler: this.options.permissionClosedHandler,
			editorSelectionResolver: this.options.editorSelectionResolver,
			onTurnCompleted: (info) => {
				this.options.onTurnCompleted?.(info);
			},
		});
		return session;
	}

	/** 创建新会话：忙碌的旧会话一律中断并释放，不保留后台执行。 */
	createNewSession(): OpenCodeSession {
		const oldSession = this.activeSession;
		if (oldSession.state.isBusy() || oldSession.hasActiveRequest()) {
			oldSession.interrupt();
		}
		oldSession.dispose();

		// 创建新的激活会话
		const newSession = this.createSessionInstance();
		this.activeSession = newSession;

		// 通知 Webview 清理并立即就绪（消除 15s 锁死）
		const seq = newSession.getAdapter().coalescer.resetStreamState();
		this.options.context.callJavaScript('clearMessages', String(seq));
		this.options.context.callJavaScript('showLoading', 'false');
		this.options.context.callJavaScript('setSessionId', '');
		this.options.context.callJavaScript('onRevertStateUpdate', JSON.stringify({ hasRevert: false }));
		this.options.context.callJavaScript('historyLoadComplete');

		return newSession;
	}

	/**
	 * 切换到目标会话：忙碌的旧会话一律中断并释放，新建实例由 HistoryHandler 恢复。
	 */
	switchToSession(sessionId: string): OpenCodeSession {
		const oldSession = this.activeSession;
		if (oldSession.state.isBusy() || oldSession.hasActiveRequest()) {
			oldSession.interrupt();
		}
		oldSession.dispose();

		const newSession = this.createSessionInstance();
		newSession.state.setSessionId(sessionId);
		this.activeSession = newSession;
		this.options.onSessionCreated?.(newSession);
		this.options.context.callJavaScript('setSessionId', sessionId);

		return newSession;
	}

	/**
	 * 中断当前前台活跃会话。
	 */
	interruptActiveSession(): void {
		this.activeSession.interrupt();
	}

	dispose(): void {
		this.activeSession.dispose();
	}
}
