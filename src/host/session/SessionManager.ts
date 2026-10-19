import { randomUUID } from 'crypto';
import { HandlerContext } from '../router/HandlerContext';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { OpenCodeSession, TurnCompletedInfo } from './OpenCodeSession';
import { PermissionRequest } from './types';

export interface SessionManagerOptions {
	context: HandlerContext;
	daemon: OpenCodeDaemonBridge;
	permissionHandler?: (request: PermissionRequest) => void;
	permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	clearSessionHandler?: (sessionId: string) => void;
	editorSelectionResolver?: () => string | null;
	onTurnCompleted?: (info: TurnCompletedInfo) => void;
	onSessionCreated?: (session: OpenCodeSession) => void;
}

/**
 * SessionManager — 宿主侧多会话生命周期管理器。
 *
 * 架构职责：
 * 1. 托管当前所有会话（sessions Map）及活跃会话 key（activeSessionKey）。
 * 2. 多会话并发流式支持：切换会话时不中断后台会话，后台会话继续消费数据流。
 * 3. 严格限制中断（interrupt）作用域，永远只针对目标会话下发精准 abort，禁止全局误杀。
 * 4. 会话关闭时精准释放资源并清理权限未决队列。
 */
export class SessionManager {
	private readonly sessions = new Map<string, OpenCodeSession>();
	private activeSessionKey: string;
	private readonly options: SessionManagerOptions;

	constructor(options: SessionManagerOptions) {
		this.options = options;
		const initialId = randomUUID();
		const session = this.createSessionInstance(initialId);
		this.sessions.set(initialId, session);
		this.activeSessionKey = initialId;
		this.options.context.registerSession(initialId, session);
		this.options.onSessionCreated?.(session);
	}

	getActiveSession(): OpenCodeSession {
		let session = this.sessions.get(this.activeSessionKey);
		if (!session) {
			const first = this.sessions.values().next().value;
			if (first) {
				session = first;
			} else {
				session = this.createNewSession();
			}
		}
		return session;
	}

	getActiveSessionKey(): string {
		return this.activeSessionKey;
	}

	getSession(sessionId: string): OpenCodeSession | undefined {
		return this.sessions.get(sessionId);
	}

	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	createSessionInstance(initialSessionId?: string | null): OpenCodeSession {
		const session = new OpenCodeSession({
			context: this.options.context,
			daemon: this.options.daemon,
			initialSessionId,
			permissionHandler: this.options.permissionHandler,
			permissionClosedHandler: this.options.permissionClosedHandler,
			editorSelectionResolver: this.options.editorSelectionResolver,
			onTurnCompleted: (info) => {
				this.options.onTurnCompleted?.(info);
			},
			onSessionIdChanged: (oldId, newId) => {
				this.rekeySession(oldId, newId, session);
			},
		});
		return session;
	}

	private rekeySession(oldId: string | null, newId: string, session: OpenCodeSession): void {
		if (oldId && oldId !== newId) {
			this.sessions.delete(oldId);
			this.options.context.removeSession(oldId);
			if (this.activeSessionKey === oldId) {
				this.activeSessionKey = newId;
			}
		}
		this.sessions.set(newId, session);
		this.options.context.registerSession(newId, session);
	}

	/**
	 * 把当前活跃会话的配置复制给一个新会话。
	 *
	 * 对应 idea `SessionLifecycleManager.createNewSession` / `createSessionForTab`：
	 * 新会话先继承上一个会话的 cwd / mode / provider / model / 推理力度，
	 * 否则新 tab 的第一轮会因为 state 为空而落到服务端默认模型上。
	 */
	private inheritConfigFrom(source: OpenCodeSession | undefined, target: OpenCodeSession): void {
		if (!source) {
			return;
		}
		const cwd = source.state.getCwd();
		if (cwd) {
			target.state.setCwd(cwd);
		}
		target.state.setPermissionMode(source.state.getPermissionMode());
		target.state.setModel(source.state.getModel());
		target.state.setReasoningEffort(source.state.getReasoningEffort());
	}

	/**
	 * 按 tab 取会话；没有就建一个。
	 *
	 * 对应 idea `createSessionForTab`：只注册、不抢占 activeSessionKey
	 * （idea 仅在 `this.session == null` 时才设为当前），也不向前端推
	 * clearMessages / setSessionId —— 这是「补登记」，不是「切会话」。
	 */
	ensureSessionForTab(tabId: string): OpenCodeSession | undefined {
		const key = tabId?.trim();
		if (!key) {
			return undefined;
		}
		const existing = this.sessions.get(key);
		if (existing) {
			return existing;
		}

		const session = this.createSessionInstance(key);
		this.inheritConfigFrom(this.sessions.get(this.activeSessionKey), session);
		this.sessions.set(key, session);
		this.options.context.registerSession(key, session);
		this.options.onSessionCreated?.(session);
		return session;
	}

	/**
	 * 创建新会话：
	 * 在多会话架构中，新会话独立分配 targetSessionId 并注册，不打断后台正在运行的其他会话。
	 */
	createNewSession(clientSessionId?: string): OpenCodeSession {
		const targetSessionId = clientSessionId && clientSessionId.trim() !== ''
			? clientSessionId.trim()
			: randomUUID();

		const newSession = this.createSessionInstance(targetSessionId);
		this.inheritConfigFrom(this.sessions.get(this.activeSessionKey), newSession);
		this.sessions.set(targetSessionId, newSession);
		this.activeSessionKey = targetSessionId;
		this.options.context.registerSession(targetSessionId, newSession);
		this.options.context.setSession(newSession);
		this.options.onSessionCreated?.(newSession);

		// 通知 Webview 清理并立即就绪（带 session 隔离首参）
		const seq = newSession.getAdapter().coalescer.resetStreamState();
		this.options.context.callJavaScript('clearMessages', targetSessionId, String(seq));
		this.options.context.callJavaScript('showLoading', targetSessionId, 'false');
		this.options.context.callJavaScript('setSessionId', targetSessionId);
		this.options.context.callJavaScript('onRevertStateUpdate', targetSessionId, JSON.stringify({ hasRevert: false }));
		// 带 (sessionId, count)：前端据此做快照对账，裸调用会让那段逻辑变成死代码。
		this.options.context.callJavaScript('historyLoadComplete', targetSessionId, '0');

		return newSession;
	}

	/**
	 * 切换到目标会话：
	 * 保持后台会话继续运行，仅切换 activeSessionKey 与 context 中的当前指向。
	 */
	switchToSession(sessionId: string): OpenCodeSession {
		if (!sessionId || sessionId.trim() === '') {
			return this.getActiveSession();
		}
		const existing = this.sessions.get(sessionId);
		if (existing) {
			this.activeSessionKey = sessionId;
			this.options.context.setSession(existing);
			this.options.context.callJavaScript('setSessionId', sessionId);
			return existing;
		}

		// 不存在则新建并绑定该 sessionId
		const newSession = this.createSessionInstance(sessionId);
		this.sessions.set(sessionId, newSession);
		this.activeSessionKey = sessionId;
		this.options.context.registerSession(sessionId, newSession);
		this.options.context.setSession(newSession);
		this.options.onSessionCreated?.(newSession);
		this.options.context.callJavaScript('setSessionId', sessionId);

		return newSession;
	}

	/**
	 * 关闭会话：精准中断并释放该会话资源。
	 */
	closeSession(sessionId: string): void {
		if (!sessionId || sessionId.trim() === '') {
			return;
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		if (session.state.isBusy() || session.hasActiveRequest()) {
			session.interrupt();
		}
		session.dispose();
		this.sessions.delete(sessionId);
		this.options.context.removeSession(sessionId);
		this.options.clearSessionHandler?.(sessionId);

		if (this.activeSessionKey === sessionId) {
			const remainingKey = this.sessions.keys().next().value;
			if (remainingKey) {
				this.switchToSession(remainingKey);
			} else {
				this.createNewSession();
			}
		}
	}

	/**
	 * 中断特定会话（精准 abort，不误杀其他会话）。
	 */
	interruptSession(sessionId?: string): void {
		if (sessionId && this.sessions.has(sessionId)) {
			this.sessions.get(sessionId)!.interrupt();
		} else {
			this.getActiveSession().interrupt();
		}
	}

	/**
	 * 中断当前前台活跃会话。
	 */
	interruptActiveSession(): void {
		this.getActiveSession().interrupt();
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			if (session.state.isBusy() || session.hasActiveRequest()) {
				session.interrupt();
			}
			session.dispose();
		}
		this.sessions.clear();
	}
}
