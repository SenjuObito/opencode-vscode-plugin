import { HandlerContext } from '../router/HandlerContext';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { PermissionRequest } from './types';
import { convertMessagesToJson } from '../util/MessageJsonConverter';

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
 * SessionManager — 宿主侧真正的多会话生命周期管理器。
 *
 * 架构职责：
 * 1. 托管当前激活会话（activeSession）与所有后台保活会话（backgroundSessions）。
 * 2. 在创建新会话或切换会话时，若旧会话处于忙碌状态且开启保活，将其移入后台静默运行，
 *    保留其流式事件解析与 state 增量更新，绝不强行 detach 弃用流或盲发全局 abort。
 * 3. 当用户切回后台运行的会话时，零延迟恢复内存状态与流式通道，实现无缝接续。
 * 4. 严格限制中断（interrupt）作用域，永远只针对目标会话下发精准 abort，禁止全局误杀。
 */
export class SessionManager {
	private activeSession: OpenCodeSession;
	private readonly backgroundSessions = new Map<string, OpenCodeSession>();
	private readonly options: SessionManagerOptions;
	private sessionCounter = 0;

	constructor(options: SessionManagerOptions) {
		this.options = options;
		this.activeSession = this.createSessionInstance();
		this.options.onSessionCreated?.(this.activeSession);
	}

	getActiveSession(): OpenCodeSession {
		return this.activeSession;
	}

	getBackgroundSession(sessionId: string): OpenCodeSession | undefined {
		return this.backgroundSessions.get(sessionId);
	}

	getAllBackgroundSessions(): OpenCodeSession[] {
		return Array.from(this.backgroundSessions.values());
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

	/**
	 * 创建新会话。
	 * @param keepRunning 是否保持旧会话在后台继续运行。
	 */
	createNewSession(keepRunning = true): OpenCodeSession {
		const oldSession = this.activeSession;
		const isOldBusy = oldSession.state.isBusy() || oldSession.hasActiveRequest();

		if (isOldBusy) {
			if (keepRunning) {
				// 将旧会话置于后台静默模式（不向 Webview 推 delta，但内部 state 持续更新）
				oldSession.setAttached(false);
				const existingId = oldSession.state.getSessionId();
				const tempKey = existingId || `pending_${++this.sessionCounter}_${Date.now()}`;
				this.backgroundSessions.set(tempKey, oldSession);

				// 若旧会话当前尚未分配 sessionId，监听其分配后迁移 map key
				if (!existingId) {
					const unsubscribe = oldSession.state.onSessionIdAssigned((realId) => {
						if (this.backgroundSessions.get(tempKey) === oldSession) {
							this.backgroundSessions.delete(tempKey);
							this.backgroundSessions.set(realId, oldSession);
						}
						unsubscribe();
					});
				}
			} else {
				// 用户明确选择不保活，则精准中断并释放
				oldSession.interrupt();
				oldSession.dispose();
			}
		} else {
			oldSession.dispose();
		}

		// 创建新的激活会话
		const newSession = this.createSessionInstance();
		this.activeSession = newSession;
		newSession.setAttached(true);
		this.options.onSessionCreated?.(newSession);

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
	 * 切换到目标会话。
	 * 若目标会话在后台运行，直接瞬时恢复；若为冷历史，创建新实例由 HistoryHandler 恢复。
	 */
	switchToSession(sessionId: string): { session: OpenCodeSession; isBackground: boolean } {
		const bgSession = this.backgroundSessions.get(sessionId);
		if (bgSession) {
			// 将当前前台会话如果处于忙碌状态，转入后台
			const oldSession = this.activeSession;
			if (oldSession !== bgSession) {
				if (oldSession.state.isBusy() || oldSession.hasActiveRequest()) {
					oldSession.setAttached(false);
					const oldId = oldSession.state.getSessionId() || `pending_${++this.sessionCounter}_${Date.now()}`;
					this.backgroundSessions.set(oldId, oldSession);
				} else {
					oldSession.dispose();
				}
			}

			this.backgroundSessions.delete(sessionId);
			this.activeSession = bgSession;
			bgSession.setAttached(true);

			// 将后台已累积的消息完整同步给 Webview
			const seq = bgSession.getAdapter().coalescer.resetStreamState();
			this.options.context.callJavaScript('clearMessages', String(seq));
			this.options.context.callJavaScript('setSessionId', sessionId);
			this.options.context.callJavaScript(
				'updateMessages',
				convertMessagesToJson(bgSession.state.getMessages()),
				String(seq),
			);
			bgSession.republishUsageFromHistory();
			const isStillActive = bgSession.state.isLoading() || bgSession.hasActiveRequest();
			const turnStartTime = bgSession.state.getActiveTurnStartTime();
			this.options.context.callJavaScript(
				'showLoading',
				String(isStillActive),
				turnStartTime ? String(turnStartTime) : '',
			);
			this.options.context.callJavaScript('historyLoadComplete');

			return { session: bgSession, isBackground: true };
		}

		// 冷历史会话：当前会话若忙碌转入后台，否则释放
		const oldSession = this.activeSession;
		if (oldSession.state.isBusy() || oldSession.hasActiveRequest()) {
			oldSession.setAttached(false);
			const oldId = oldSession.state.getSessionId() || `pending_${++this.sessionCounter}_${Date.now()}`;
			this.backgroundSessions.set(oldId, oldSession);
		} else {
			oldSession.dispose();
		}

		const newSession = this.createSessionInstance();
		newSession.state.setSessionId(sessionId);
		this.activeSession = newSession;
		newSession.setAttached(true);
		this.options.onSessionCreated?.(newSession);
		this.options.context.callJavaScript('setSessionId', sessionId);

		return { session: newSession, isBackground: false };
	}

	/**
	 * 中断当前前台活跃会话。
	 */
	interruptActiveSession(): void {
		this.activeSession.interrupt();
	}

	/**
	 * 中断指定会话（精准定向中断，绝不全局误杀）。
	 */
	interruptSession(sessionId?: string): void {
		if (!sessionId || sessionId === this.activeSession.state.getSessionId()) {
			this.activeSession.interrupt();
			return;
		}
		const bg = this.backgroundSessions.get(sessionId);
		if (bg) {
			bg.interrupt();
		}
	}

	dispose(): void {
		this.activeSession.dispose();
		for (const bg of this.backgroundSessions.values()) {
			bg.dispose();
		}
		this.backgroundSessions.clear();
	}
}
