import { HandlerContext } from '../router/HandlerContext';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { PermissionRequest } from './types';
import type { JsTarget } from './SessionCallbackAdapter';

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
	/**
	 * 多 tab 装配下的「活跃会话」解析器：由 ChatWindow 注入，按 activeTabId 取
	 * 该 tab 自己绑定的会话。未注入时退回本地的单会话实例（单视图/测试路径）。
	 */
	private sessionResolver: (() => OpenCodeSession | null) | null = null;
	/** 按 sessionId 反查会话（后台 tab 的回合结束时取它自己的 model 等）。 */
	private sessionLookup: ((sessionId: string) => OpenCodeSession | null) | null = null;
	/**
	 * 多 tab 下的「替换活跃会话」实现：由 ChatWindow 注入，按 activeTabId 换掉
	 * 该 tab 的会话（新对话 / 切历史）。注入后 `createNewSession` /
	 * `switchToSession` 不再销毁共享实例，而是委托给它。
	 */
	private activeSessionReplacer: ((sessionId: string | null) => OpenCodeSession | null) | null = null;

	constructor(options: SessionManagerOptions) {
		this.options = options;
		this.activeSession = this.createSessionInstance();
		this.options.onSessionCreated?.(this.activeSession);
	}

	/** 注入活跃会话解析器（多 tab）。传 null 恢复单会话语义。 */
	setSessionResolver(resolver: (() => OpenCodeSession | null) | null): void {
		this.sessionResolver = resolver;
	}

	/** 注入按 sessionId 反查会话的能力（多 tab）。 */
	setSessionLookup(lookup: ((sessionId: string) => OpenCodeSession | null) | null): void {
		this.sessionLookup = lookup;
	}

	/** 注入「替换活跃会话」的实现（多 tab：新对话 / 切历史都落到活跃 tab）。 */
	setActiveSessionReplacer(replacer: ((sessionId: string | null) => OpenCodeSession | null) | null): void {
		this.activeSessionReplacer = replacer;
	}

	/** 解析器生效时，本地实例只是兜底，不参与 UI。 */
	isTabOwned(): boolean {
		return this.sessionResolver !== null;
	}

	getActiveSession(): OpenCodeSession {
		const resolved = this.sessionResolver?.();
		return resolved ?? this.activeSession;
	}

	/** 按 sessionId 找会话；未注入 lookup 时只认本地实例。 */
	findSession(sessionId: string | null | undefined): OpenCodeSession | null {
		if (!sessionId) {
			return this.getActiveSession();
		}
		const found = this.sessionLookup?.(sessionId) ?? null;
		if (found) {
			return found;
		}
		return this.activeSession.state.getSessionId() === sessionId ? this.activeSession : null;
	}

	/** 创建会话实例；`viewSink` 让多 tab 的输出带上归属。 */
	createSessionInstance(options?: {
		viewSink?: JsTarget;
		autoOpenFileEnabledResolver?: () => boolean | null | undefined;
	}): OpenCodeSession {
		const session = new OpenCodeSession({
			context: this.options.context,
			daemon: this.options.daemon,
			permissionHandler: this.options.permissionHandler,
			permissionClosedHandler: this.options.permissionClosedHandler,
			editorSelectionResolver: this.options.editorSelectionResolver,
			viewSink: options?.viewSink,
			autoOpenFileEnabledResolver: options?.autoOpenFileEnabledResolver,
			onTurnCompleted: (info) => {
				this.options.onTurnCompleted?.(info);
			},
		});
		return session;
	}

	/** 创建新会话：忙碌的旧会话一律中断并释放，不保留后台执行。 */
	createNewSession(): OpenCodeSession {
		// 多 tab：会话归 tab 所有，不能在活跃 tab 底下把它的会话换掉之后又留着旧实例。
		// 交给 ChatWindow 在活跃 tab 内重置（保留 tab 的界面与位置）。
		if (this.activeSessionReplacer) {
			const replaced = this.activeSessionReplacer(null);
			if (replaced) {
				this.pushFreshSessionState(replaced);
				return replaced;
			}
		}

		const oldSession = this.activeSession;
		if (oldSession.state.isBusy() || oldSession.hasActiveRequest()) {
			oldSession.interrupt();
		}
		oldSession.dispose();

		// 创建新的激活会话
		const newSession = this.createSessionInstance();
		this.activeSession = newSession;

		this.pushFreshSessionState(newSession);
		return newSession;
	}

	/**
	 * 切换到目标会话：忙碌的旧会话一律中断并释放，新建实例由 HistoryHandler 恢复。
	 */
	switchToSession(sessionId: string): OpenCodeSession {
		if (this.activeSessionReplacer) {
			const replaced = this.activeSessionReplacer(sessionId);
			if (replaced) {
				this.options.context.callJavaScript('setSessionId', sessionId);
				return replaced;
			}
		}

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

	/** 通知 Webview 清理并立即就绪（消除 15s 锁死）。 */
	private pushFreshSessionState(session: OpenCodeSession): void {
		const seq = session.getAdapter().coalescer.resetStreamState();
		this.options.context.callJavaScript('clearMessages', String(seq));
		this.options.context.callJavaScript('showLoading', 'false');
		this.options.context.callJavaScript('setSessionId', '');
		this.options.context.callJavaScript('onRevertStateUpdate', JSON.stringify({ hasRevert: false }));
		this.options.context.callJavaScript('historyLoadComplete');
	}

	/**
	 * 中断当前前台活跃会话。
	 */
	interruptActiveSession(): void {
		this.getActiveSession().interrupt();
	}

	dispose(): void {
		this.activeSession.dispose();
	}
}
