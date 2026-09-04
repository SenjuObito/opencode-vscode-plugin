/**
 * WindowEventHandler — port of cc-gui `handler/WindowEventHandler.java`.
 * Handles window-level events: heartbeat, create_new_session, frontend_ready,
 * refresh_slash_commands, history_dom_committed.
 */
import * as vscode from 'vscode';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { logDiagnostic, logDiagnosticBlock } from '../util/DiagnosticLogger';
import { pushHistoryData, upsertSessionSummary } from '../session/SessionHistoryStore';
import { classifyServeFailure, type DaemonStatusPayload } from '../provider/DaemonStatus';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { pushUserLanguageConfig, pushUiPreferences } from './SettingsHandler';

const SUPPORTED_TYPES = [
	'heartbeat',
	'tab_loading_changed',
	'tab_status_changed',
	'create_new_session',
	'frontend_ready',
	'history_dom_committed',
	'history_render_complete',
	'refresh_slash_commands',
	'refresh_file',
	'get_active_provider',
	'get_thinking_enabled',
	'check_daemon_status',
	'open_external_url',
	'copy_to_clipboard',
	'share_session',
	'unshare_session',
	'revert_session',
	'unrevert_session',
	'fork_session',
	'compact_session',
];

/**
 * daemon / serve 启动失败时的 VS Code 通知文案（宿主侧，不经 i18n）。
 * 只覆盖「用户需要看到并可能动手」的失败；DAEMON_DIED / NO_DAEMON 等
 * 瞬态或 webview 已说明的情况不在此列，避免误报噪声。
 */
const DAEMON_FAILURE_TOAST: Record<string, (p: DaemonStatusPayload) => string> = {
	NOT_INSTALLED: (p) =>
		`未检测到 opencode，请先安装后再使用 OpenCode 服务。安装命令：${p.installCmd ?? ''}`.trim(),
	START_TIMEOUT: (p) => `OpenCode 服务启动超时${p.detail ? `：${p.detail}` : '，请检查 opencode 是否可正常运行'}`,
	START_FAILED: (p) => `OpenCode 服务启动失败${p.detail ? `：${p.detail}` : ''}`,
	BRIDGE_DEPS_MISSING: (p) =>
		`OpenCode 桥接进程依赖缺失，无法启动${p.detail ? `：${p.detail}` : ''}（请到 ai-bridge 目录执行 npm install）`,
	BRIDGE_LAUNCH_FAILED: (p) => `OpenCode 桥接进程拉起失败${p.detail ? `：${p.detail}` : ''}`,
	BRIDGE_START_FAILED: (p) => `OpenCode 桥接进程启动超时${p.detail ? `：${p.detail}` : ''}`,
};

export class WindowEventHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'heartbeat':
				// 心跳由 daemon 生命周期管理；这里仅确认存活
				return true;
			case 'create_new_session':
				this.handleCreateNewSession();
				return true;
			case 'frontend_ready':
				this.handleFrontendReady();
				return true;
			case 'refresh_slash_commands':
				this.handleRefreshSlashCommands();
				return true;
			case 'get_active_provider':
				this.handleGetActiveProvider();
				return true;
		case 'get_thinking_enabled':
			// opencode 无 thinking 开关；回默认关闭
			this.callJavaScript('updateThinkingEnabled', JSON.stringify({ enabled: false }));
			return true;
		case 'check_daemon_status':
			// 用户在「OpenCode serve 未运行」提示上点重试：重新探测并等待 serve 就绪。
			this.sendDaemonStatus();
			return true;
		case 'open_external_url':
			this.handleOpenExternalUrl(content);
			return true;
		case 'copy_to_clipboard':
			this.handleCopyToClipboard(content);
			return true;
			case 'share_session':
				this.handleShareSession(content);
				return true;
			case 'unshare_session':
				this.handleUnshareSession(content);
				return true;
			case 'revert_session':
				this.handleRevertSession(content);
				return true;
			case 'unrevert_session':
				this.handleUnrevertSession();
				return true;
			case 'fork_session':
				this.handleForkSession(content);
				return true;
			case 'compact_session':
				this.handleCompactSession();
				return true;
		case 'history_dom_committed':
		case 'history_render_complete':
		case 'tab_loading_changed':
		case 'tab_status_changed':
		case 'refresh_file':
			// 前端渲染确认或文件刷新通知，无后端副作用
			return true;
			default:
				return false;
		}
	}

	private handleCreateNewSession(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		session.resetSession();
		this.callJavaScript('showLoading', 'false');
	}

	/** frontend_ready：回放会话状态 / provider / mode / 依赖 / slash 命令 / linkify。 */
	private handleFrontendReady(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}

		this.callJavaScript(
			'applyBackendTabState',
			JSON.stringify({
				provider: 'opencode',
				model: session.state.getModel() ?? '',
				permissionMode: session.state.getPermissionMode(),
				reasoningEffort: session.state.getReasoningEffort(),
			}),
		);

		this.pushActiveProvider();

		this.callJavaScript('onModeReceived', session.state.getPermissionMode());

		const sessionId = session.state.getSessionId();
		if (sessionId) {
			this.callJavaScript('setSessionId', sessionId);
		}

		this.handleRefreshSlashCommands();
		this.sendDaemonStatus();
		this.sendLinkifyCapabilities();

		// 语言回放：手动设置过 → source 'user'；否则跟随 IDE 界面语言。
		// webview 的 applyIdeaLanguageConfig 会 changeLanguage 并写 localStorage。
		pushUserLanguageConfig((fn, ...args) => this.callJavaScript(fn, ...args), this.context.getSettingsService());

		// UI 偏好回放（主题 / 字号 / 配色 / diff / 行为开关）：webview 的
		// localStorage 在 VS Code 重建 webview 后会丢，宿主才是权威源。
		pushUiPreferences((fn, ...args) => this.callJavaScript(fn, ...args), this.context.getSettingsService());

		// 推送当前编辑器上下文（需在 webview JS 就绪后调用）。
		this.context.pushEditorContext();
	}

	/** bootstrap 的 get_active_provider：回推 opencode provider 配置。 */
	private handleGetActiveProvider(): void {
		this.pushActiveProvider();
	}

	private pushActiveProvider(): void {
		this.callJavaScript(
			'updateActiveProvider',
			JSON.stringify({
				provider: 'opencode',
				id: 'opencode',
				name: 'OpenCode',
				type: 'opencode',
			}),
		);
	}

	private handleRefreshSlashCommands(): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.pushSlashCommands([]);
			return;
		}

		const chunks: string[] = [];
		void daemon.request('opencode.listCommands', {}, {
			onLine: (line) => chunks.push(line),
			onError: () => this.pushSlashCommands([]),
			onComplete: (success) => {
				// 单一数据源：SDK command.list（含 opencode 全部内置命令）。
				// 失败时回推空列表——绝不展示可能不存在的硬编码"幽灵命令"。
				if (!success) {
					this.pushSlashCommands([]);
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const raw = payload && Array.isArray(payload.commands) ? payload.commands : [];
				const commands: Array<{ name: string; description?: string; source?: string }> = [];
				for (const c of raw) {
					const cmd = c as Record<string, unknown>;
					const rawName = typeof cmd?.name === 'string' ? cmd.name : '';
					const name = rawName.replace(/^\//, '');
					if (!name) {
						continue;
					}
					commands.push({
						name,
						description: typeof cmd.description === 'string' ? cmd.description : undefined,
						source:
							cmd.source === 'command' || cmd.source === 'mcp' || cmd.source === 'skill'
								? String(cmd.source)
								: undefined,
					});
				}
				this.pushSlashCommands(commands);
			},
		});
	}

	private pushSlashCommands(commands: Array<{ name: string; description?: string; source?: string }>): void {
		this.callJavaScript('updateSlashCommands', JSON.stringify(commands));
	}

	/** 从 daemon 输出缓冲区提取 JSON 对象（容错非 JSON 诊断行）。 */
	private extractJsonObject(raw: string): Record<string, unknown> | null {
		if (!raw || raw.trim() === '') {
			return null;
		}
		const lines = raw.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line.startsWith('{') || !line.endsWith('}')) {
				continue;
			}
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj && (obj.commands !== undefined || obj.success !== undefined)) {
					return obj;
				}
			} catch {
				// 跳过
			}
		}
		try {
			const start = raw.lastIndexOf('{');
			const end = raw.lastIndexOf('}');
			if (start >= 0 && end > start) {
				return JSON.parse(raw.substring(start, end + 1)) as Record<string, unknown>;
			}
		} catch {
			// 忽略
		}
		return null;
	}

	/** webview 内 window.open / <a target=_blank> 被 VS Code 拦截，改由宿主 openExternal。 */
	private handleOpenExternalUrl(content: string): void {
		const url = (content ?? '').trim();
		if (!/^https?:\/\//i.test(url)) {
			return;
		}
		this.context.getFileOps().openExternal(url);
	}

	/**
	 * webview 内 navigator.clipboard / execCommand 受权限策略限制不可靠，
	 * 关键复制（分享链接等）改走宿主 vscode.env.clipboard。完成后回推结果。
	 */
	private handleCopyToClipboard(content: string): void {
		const text = content ?? '';
		let ok = false;
		try {
			ok = text.length > 0 && this.context.getFileOps().copyToClipboard(text);
		} catch (err) {
			console.error('[WindowEventHandler] copy_to_clipboard failed:', err);
		}
		this.callJavaScript('onCopyToClipboardResult', ok ? 'true' : 'false');
	}

	private handleShareSession(sessionId: string): void {
		const daemon = this.context.getDaemon();
		if (!daemon || !sessionId) {
			logDiagnostic(`[share] skipped: daemon=${!!daemon} sessionId="${sessionId}"`);
			return;
		}

		logDiagnostic(`[share] request sessionId=${sessionId}`);
		const chunks: string[] = [];
		let errorReported = false;
		const reportError = (detail?: string): void => {
			if (errorReported) {
				return;
			}
			errorReported = true;
			logDiagnostic(`[share] FAILED detail=${detail ?? '(none)'}`);
			this.callJavaScript('onShareError', detail ?? '');
		};
		void daemon.request('opencode.shareSession', { sessionId }, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				console.error('[WindowEventHandler] Failed to share session:', error);
				reportError(error);
			},
			onComplete: (success) => {
				logDiagnosticBlock('[share] daemon raw output', chunks.join('\n'));
				if (!success) {
					console.error('[WindowEventHandler] Share session failed');
					reportError();
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				logDiagnostic(`[share] parsed payload=${JSON.stringify(payload)}`);
				if (payload && payload.share && typeof payload.share === 'object') {
					const shareObj = payload.share as Record<string, unknown>;
					// SDK v2 的 session.share 返回更新后的会话对象（Session.Info），
					// url 嵌在 share.share.url 两层；兼容旧的一层 {url} 形态。
					const nested = typeof shareObj.share === 'object' && shareObj.share !== null
						? shareObj.share as Record<string, unknown>
						: undefined;
					const url = [shareObj.url, nested?.url].find(
						(u): u is string => typeof u === 'string' && u !== '',
					);
					if (url) {
						logDiagnostic(`[share] SUCCESS url=${url}`);
						this.callJavaScript('onShareSuccess', url);
						return;
					}
				}
				// 服务端未返回分享链接（如 opencode 关闭了 share 功能）
				reportError();
			},
		});
	}

	private handleUnshareSession(sessionId: string): void {
		const daemon = this.context.getDaemon();
		if (!daemon || !sessionId) {
			return;
		}

		void daemon.request('opencode.unshareSession', { sessionId }, {
			onLine: () => {},
			onError: () => {
				console.error('[WindowEventHandler] Failed to unshare session');
			},
			onComplete: (success) => {
				if (!success) {
					console.error('[WindowEventHandler] Unshare session failed');
				}
			},
		});
	}

	private handleCompactSession(): void {
		const daemon = this.context.getDaemon();
		const session = this.context.getSession();
		if (!daemon || !session) {
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			return;
		}

		void daemon.request('opencode.summarize', {
			sessionId,
		}, {
			onLine: () => {},
			onError: () => {
				console.error('[WindowEventHandler] Failed to compact session');
				this.callJavaScript('showError', 'Failed to compact session');
			},
			onComplete: (success) => {
				if (!success) {
					console.error('[WindowEventHandler] Compact session failed');
					return;
				}
				this.callJavaScript('onCompactSuccess', '');
			},
		});
	}

	private handleRevertSession(messageId: string): void {
		const daemon = this.context.getDaemon();
		const session = this.context.getSession();
		logDiagnostic(`[revert] request messageId="${messageId}" daemon=${!!daemon} session=${!!session}`);
		if (!daemon || !session) {
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			logDiagnostic('[revert] skipped: no active sessionId');
			return;
		}

		this.withMessageId(daemon, sessionId, messageId, '[revert]', (resolvedId) => {
			const chunks: string[] = [];
			void daemon.request('opencode.revert', {
				sessionId,
				messageID: resolvedId,
			}, {
				onLine: (line) => chunks.push(line),
				onError: (error) => {
					console.error('[WindowEventHandler] Failed to revert session:', error);
					logDiagnostic(`[revert] FAILED error=${error}`);
					this.callJavaScript('onRevertError', JSON.stringify({ op: 'undo', error }));
				},
				onComplete: (success) => {
					logDiagnosticBlock('[revert] daemon raw output', chunks.join('\n'));
					if (!success) {
						console.error('[WindowEventHandler] Revert session failed');
						this.callJavaScript('onRevertError', JSON.stringify({ op: 'undo' }));
						return;
					}
					this.pushRevertStateFromResponse(chunks.join('\n'));
				},
			});
		});
	}

	private handleUnrevertSession(): void {
		const daemon = this.context.getDaemon();
		const session = this.context.getSession();
		if (!daemon || !session) {
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			logDiagnostic('[unrevert] skipped: no active sessionId');
			return;
		}

		logDiagnostic(`[unrevert] request sessionId=${sessionId}`);
		const chunks: string[] = [];
		void daemon.request('opencode.unrevert', {
				sessionId,
			}, {
				onLine: (line) => chunks.push(line),
				onError: (error) => {
					console.error('[WindowEventHandler] Failed to unrevert session:', error);
					logDiagnostic(`[unrevert] FAILED error=${error}`);
					this.callJavaScript('onRevertError', JSON.stringify({ op: 'redo', error }));
				},
				onComplete: (success) => {
					logDiagnosticBlock('[unrevert] daemon raw output', chunks.join('\n'));
					if (!success) {
						console.error('[WindowEventHandler] Unrevert session failed');
						this.callJavaScript('onRevertError', JSON.stringify({ op: 'redo' }));
						return;
					}
					this.pushRevertStateFromResponse(chunks.join('\n'));
				},
			});
	}

	/** Parse a `{ success, session }` daemon response and push the session's revert state to the frontend. */
	private pushRevertStateFromResponse(raw: string): void {
		const payload = this.extractJsonObject(raw);
		const sessionObj = payload?.session as Record<string, unknown> | undefined;
		const revert = (sessionObj?.revert ?? null) as { messageID?: string } | null;
		logDiagnostic(`[revert-state] hasRevert=${!!revert} revert=${JSON.stringify(revert)}`);
		// 记录到会话状态：切换/恢复会话后可重新推送给前端
		this.context.getSession()?.state.setRevertState(
			revert && typeof revert.messageID === 'string' ? { messageID: revert.messageID } : null,
		);
		this.callJavaScript('onRevertStateUpdate', JSON.stringify({
			hasRevert: !!revert,
			messageId: revert && typeof revert.messageID === 'string' ? revert.messageID : null,
		}));
	}

	/**
	 * 解析 undo/fork 目标消息 ID：webview 传入的 id 可能为空（live 消息未携带
	 * opencode 的 msg_xxx ID）。此时回源 daemon listMessages 取最后一条用户消息。
	 */
	private withMessageId(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		sessionId: string,
		messageId: string,
		label: string,
		run: (resolvedId: string) => void,
	): void {
		if (messageId && messageId !== 'latest') {
			run(messageId);
			return;
		}
		logDiagnostic(`[${label}] messageId empty — resolving latest user message via listMessages`);
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		void daemon.request('opencode.listMessages', { sessionId, directory }, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				logDiagnostic(`[${label}] listMessages FAILED error=${error}`);
			},
			onComplete: (success) => {
				if (!success) {
					logDiagnostic(`[${label}] listMessages failed — abort`);
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const entries = payload && Array.isArray(payload.messages) ? payload.messages : [];
				let latestUserId: string | null = null;
				for (const entry of entries as Array<Record<string, unknown>>) {
					const info = entry?.info as Record<string, unknown> | undefined;
					if (info && info.role === 'user' && typeof info.id === 'string' && info.id) {
						latestUserId = info.id;
					}
				}
				logDiagnostic(`[${label}] resolved latest user message id=${latestUserId ?? '(none)'}`);
				if (latestUserId) {
					run(latestUserId);
				}
			},
		});
	}

	private handleForkSession(messageId: string): void {
		const daemon = this.context.getDaemon();
		const session = this.context.getSession();
		logDiagnostic(`[fork] request messageId="${messageId}" daemon=${!!daemon} session=${!!session}`);
		if (!daemon || !session) {
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			logDiagnostic('[fork] skipped: no active sessionId');
			return;
		}

		// 双保险：webview 已在流式期间禁用 fork 按钮，这里兜底拒绝。
		// daemon 命令队列会把 fork 排队到回合结束，且流式中 fork 出的是不完整快照。
		if (session.state.isBusy()) {
			logDiagnostic('[fork] skipped: session busy');
			this.callJavaScript('onForkError', 'session busy');
			return;
		}

		// 双语义：'full' = 全量复制（不带 messageID）；其余 = 从指定消息处
		// 分叉（服务端 exclusive 语义，不含该条）。空/'latest' 交由
		// withMessageId 解析为最后一条用户消息。
		if (messageId === 'full') {
			this.requestFork(daemon, sessionId, undefined);
			return;
		}

		this.withMessageId(daemon, sessionId, messageId, '[fork]', (resolvedId) => {
			this.requestFork(daemon, sessionId, resolvedId);
		});
	}

	private requestFork(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		sessionId: string,
		messageID: string | undefined,
	): void {
		const chunks: string[] = [];
		void daemon.request('opencode.fork', messageID ? { sessionId, messageID } : { sessionId }, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				console.error('[WindowEventHandler] Failed to fork session:', error);
				logDiagnostic(`[fork] FAILED error=${error}`);
				this.callJavaScript('onForkError', error);
			},
			onComplete: (success) => {
				logDiagnosticBlock('[fork] daemon raw output', chunks.join('\n'));
				if (!success) {
					console.error('[WindowEventHandler] Fork session failed');
					this.callJavaScript('onForkError', '');
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const newSessionId = payload && typeof payload.newSessionId === 'string' ? payload.newSessionId : '';
				logDiagnostic(`[fork] newSessionId="${newSessionId}"`);
				if (newSessionId) {
					// fork 出的会话不在本地历史缓存里 —— 拉取标题登记后立即推送
					// 会话列表，保证 webview 历史视图与 loadHistorySession 的
					// summary 查找都能命中。
					this.registerForkedSession(newSessionId);
					this.callJavaScript('onForkSuccess', JSON.stringify({ sessionId: newSessionId }));
				}
			},
		});
	}

	/** fork 成功后：拉取新会话标题 → 登记历史缓存 → 推送会话列表。 */
	private registerForkedSession(newSessionId: string): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		void daemon.request('opencode.getSessionInfo', { sessionId: newSessionId, directory }, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				logDiagnostic(`[fork] getSessionInfo FAILED error=${error}`);
			},
			onComplete: (success) => {
				let title = '';
				if (success) {
					const payload = this.extractJsonObject(chunks.join('\n'));
					const info = payload?.session as { title?: string } | undefined;
					title = typeof info?.title === 'string' ? info.title.trim() : '';
				}
				upsertSessionSummary(
					this.context.getSettingsService().getStore(),
					newSessionId,
					title,
				);
				pushHistoryData(this.context.getChannel(), this.context.getSettingsService().getStore());
			},
		});
	}

	/**
	 * 向 webview 推送 daemon / serve 状态。
	 *
	 * 协议见 host/provider/DaemonStatus.ts：载荷带 `phase`，webview 据此在
	 * 「启动中（转圈）/ 已就绪（收起）/ 启动失败（展示原因）」之间切换。
	 *
	 * 关键约定：
	 * - 状态栏必须等到 opencode serve 真正就绪（phase='ready'）才收起，而不是
	 *   daemon 进程一拉起就收起——否则会出现「首次加载历史会话时 serve 尚在
	 *   预热、listMessages 打到冷 serve 返回空消息」的竞态。
	 * - daemon 未运行时「重试」会真正调用 daemon.start() 重新拉起，而不是只
	 *   把当前状态再读一遍（旧行为下重试按钮等于没反应）。
	 * - 拉不起来时必须带上失败原因（未安装 / 超时 / 意外退出 …），不能只剩一句
	 *   「OpenCode serve 未运行」。
	 */
	private sendDaemonStatus(): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			logDiagnostic('[daemon-status] sendDaemonStatus: 没有 daemon 实例 (NO_DAEMON)');
			this.pushDaemonStatus({
				alive: false,
				serveReady: false,
				phase: 'failed',
				code: 'NO_DAEMON',
				detail: 'OpenCode 桥接进程尚未初始化，请重新打开窗口后重试。',
			});
			return;
		}
		if (daemon.isAlive()) {
			logDiagnostic('[daemon-status] sendDaemonStatus: daemon 已存活 → 直接探测 serve 就绪');
			this.waitForServeReady(daemon);
			return;
		}
		logDiagnostic('[daemon-status] sendDaemonStatus: daemon 未运行 → 先拉起再等 serve');
		void this.startDaemonThenServe(daemon);
	}

	/** daemon 进程不在：先把它拉起来，再等 serve 就绪；拉不起来则回传原因。 */
	private async startDaemonThenServe(daemon: OpenCodeDaemonBridge): Promise<void> {
		logDiagnostic('[daemon-status] startDaemonThenServe: phase=starting，调用 daemon.start()');
		this.pushDaemonStatus({ alive: false, serveReady: false, phase: 'starting' });
		let started = false;
		try {
			started = await daemon.start();
		} catch (err) {
			const detail = `拉起 opencode 桥接进程时出错：${(err as Error).message}`;
			logDiagnostic(`[daemon-status] startDaemonThenServe 异常: ${detail}`);
			console.error(`[OpenCodeGUI][daemon-status] daemon.start() 抛异常: ${detail}`);
			this.pushDaemonStatus({
				alive: false,
				serveReady: false,
				phase: 'failed',
				code: 'BRIDGE_LAUNCH_FAILED',
				detail,
			});
			return;
		}
		if (!started || !daemon.isAlive()) {
			const failure = daemon.getLastFailure();
			logDiagnostic(
				`[daemon-status] daemon.start() 返回失败: started=${started} alive=${daemon.isAlive()} ` +
				`failure=${failure ? `${failure.code} | ${failure.detail}` : '(无 lastFailure)'}`,
			);
			this.pushDaemonStatus({
				alive: false,
				serveReady: false,
				phase: 'failed',
				code: failure?.code ?? 'BRIDGE_START_FAILED',
				detail: failure?.detail ?? 'opencode 桥接进程未能启动，且未记录到具体原因。',
			});
			return;
		}
		logDiagnostic('[daemon-status] daemon.start() 成功，转 waitForServeReady');
		this.waitForServeReady(daemon);
	}

	/**
	 * daemon 已就绪：异步等 opencode serve 真正就绪后再发 phase='ready'。
	 * 复用 opencode.preconnect（内部 _ensureReady 会轮询健康检查直到 serve 可查，
	 * 幂等、可重复调用）。
	 */
	private waitForServeReady(daemon: OpenCodeDaemonBridge): void {
		this.pushDaemonStatus({ alive: true, serveReady: false, phase: 'starting' });

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		logDiagnostic(`[daemon-status] waitForServeReady: 发送 opencode.preconnect (cwd=${directory ?? '(无)'})`);
		// handleDaemonOutput 会先 onError 再 onComplete，用 reported 保证带分类码的
		// onError 结果不被随后那次无信息的 onComplete(false) 覆盖。
		let reported = false;
		const reportFailure = (error?: string, code?: string): void => {
			if (reported) {
				return;
			}
			reported = true;
			if (code) {
				logDiagnostic(`[daemon-status] serve 启动失败: code=${code} error=${error ?? '(空)'}`);
			} else {
				logDiagnostic(`[daemon-status] serve 启动失败（无分类码）: ${error ?? '(空)'}`);
			}
			this.pushDaemonStatus(classifyServeFailure(error, code));
		};

		void daemon.request('opencode.preconnect', { cwd: directory }, {
			onLine: () => {},
			onError: (error, code) => reportFailure(error, code),
			onComplete: (success: boolean) => {
				if (success) {
					reported = true;
					logDiagnostic('[daemon-status] serve 就绪: phase=ready');
					this.pushDaemonStatus({ alive: true, serveReady: true, phase: 'ready' });
					return;
				}
				logDiagnostic('[daemon-status] opencode.preconnect 返回未成功，按失败处理');
				reportFailure();
			},
		});
	}

	private pushDaemonStatus(payload: DaemonStatusPayload): void {
		// 成功就绪后清空「失败通知」去重标记，使下一次真正的失败仍能弹通知。
		if (payload.phase === 'ready') {
			this.lastDaemonFailureToastSig = undefined;
		}
		// 调试日志（Debug Console 可见）：把每次状态推送的完整载荷打出来，便于排查
		// 「拉不起来却毫无提示」这类问题。失败态用 console.error 标红。
		const summary = `phase=${payload.phase ?? '(旧协议)'} alive=${payload.alive} serveReady=${payload.serveReady}` +
			(payload.code ? ` code=${payload.code}` : '') +
			(payload.detail ? ` detail=${payload.detail}` : '');
		logDiagnostic(`[daemon-status] push: ${summary}`);
		if (payload.phase === 'failed') {
			console.error(`[OpenCodeGUI][daemon-status] 推送失败态: ${summary}`);
		}
		this.callJavaScript('updateDaemonStatus', JSON.stringify(payload));
		// 启动失败时再补一条 VS Code 警告通知，避免用户只看到输入框顶部的小条而漏掉。
		if (payload.phase === 'failed') {
			this.notifyDaemonFailure(payload);
		}
	}

	/**
	 * 把「OpenCode 服务拉不起来」的具体原因，用一条 VS Code 警告通知（toast）弹出来，
	 * 让「未安装 / 启动超时 / 桥接进程崩溃」这类问题无法被忽略。
	 *
	 * DAEMON_DIED（自动重启中）/ NO_DAEMON 不打扰——它们要么会被自动恢复，
	 * 要么 webview 小条已说明，弹通知反而像报错。
	 * 用 `code + detail` 去重，避免重试 / 多次健康探测时同一条失败反复弹窗。
	 */
	private lastDaemonFailureToastSig?: string;

	private notifyDaemonFailure(payload: DaemonStatusPayload): void {
		const code = payload.code ?? 'START_FAILED';
		const builder = DAEMON_FAILURE_TOAST[code];
		if (!builder) {
			return;
		}
		const sig = `${code}|${payload.detail ?? ''}`;
		if (sig === this.lastDaemonFailureToastSig) {
			return;
		}
		this.lastDaemonFailureToastSig = sig;
		const message = builder(payload);
		logDiagnostic(`[daemon-status] 弹失败通知(${code}): ${message}`);
		if (code === 'NOT_INSTALLED' && payload.installCmd) {
			void vscode.window
				.showWarningMessage(message, '复制安装命令')
				.then((choice) => {
					if (choice === '复制安装命令') {
						void vscode.env.clipboard.writeText(payload.installCmd ?? '');
					}
				});
		} else {
			void vscode.window.showWarningMessage(message);
		}
	}

	private sendLinkifyCapabilities(): void {
		this.callJavaScript(
			'updateLinkifyCapabilities',
			JSON.stringify({ classNavigationEnabled: false, linkifyCapabilities: { file: true, line: true, url: true } }),
		);
	}
}
