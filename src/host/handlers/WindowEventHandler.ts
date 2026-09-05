/**
 * WindowEventHandler — port of cc-gui `handler/WindowEventHandler.java`.
 * Handles window-level events: heartbeat, create_new_session, frontend_ready,
 * refresh_slash_commands, history_dom_committed.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { logDiagnostic, logDiagnosticBlock } from '../util/DiagnosticLogger';
import { pushHistoryData, upsertSessionSummary } from '../session/SessionHistoryStore';
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

export class WindowEventHandler extends BaseMessageHandler {
	/** 压缩请求超时上限：opencode 的 summarize 是一次 LLM 调用，大会话可达数分钟。 */
	private static readonly COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

	private compactPending = false;
	private compactSessionId: string | null = null;
	private compactTimer: ReturnType<typeof setTimeout> | null = null;
	private compactSettled = false;
	private daemonListenerRegistered = false;

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

		this.compactPending = true;
		this.compactSessionId = sessionId;
		this.compactSettled = false;
		this.registerCompactResultListener(daemon);

		// 结果统一从 settleCompact 走：SSE marker（session.compacted /
		// session.error）、daemon done 信号、超时三者先到先得，只结算一次。
		this.compactTimer = setTimeout(() => {
			this.settleCompact(false, '压缩超时，请稍后查看会话状态或重试');
		}, WindowEventHandler.COMPACT_TIMEOUT_MS);

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;

		void daemon.request('opencode.summarize', {
			sessionId,
			directory,
			// summarize 端点要求 body { providerID, modelID }；null（使用 opencode
			// 默认模型）时不传，由 daemon 回退到会话运行时记录的模型。
			model: session.state.getModel() ?? undefined,
		}, {
			onLine: () => {},
			onError: (error) => {
				console.error('[WindowEventHandler] Failed to compact session:', error);
				// daemon 返回 error 时会同时回调 onError + onComplete(false)，
				// settleCompact 去重。
				this.settleCompact(false, error);
			},
			onComplete: (success) => {
				if (!success) {
					console.error('[WindowEventHandler] Compact session failed');
					this.settleCompact(false);
					return;
				}
				this.settleCompact(true);
			},
		});
	}

	private clearCompactState(): void {
		this.compactPending = false;
		this.compactSessionId = null;
		if (this.compactTimer) {
			clearTimeout(this.compactTimer);
			this.compactTimer = null;
		}
	}

	private settleCompact(success: boolean, detail?: string): void {
		if (this.compactSettled) {
			return;
		}
		this.compactSettled = true;
		this.clearCompactState();
		if (success) {
			this.callJavaScript('onCompactSuccess', '');
		} else {
			// showError 只在设置视图注册；对话视图用 onCompactError toast。
			this.callJavaScript('onCompactError', detail ?? '');
		}
	}

	/**
	 * 压缩没有活跃 turn 承载 done 信号，opencode 的 session.compacted /
	 * session.error 事件经 daemon 越权 marker 上报（daemon log 事件载体）。
	 * 懒注册一个共享监听器解析该 marker；只有当前存在 pending 压缩且
	 * sessionId 匹配时才结算。
	 */
	private registerCompactResultListener(daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>): void {
		if (this.daemonListenerRegistered) {
			return;
		}
		this.daemonListenerRegistered = true;
		daemon.addEventListener({
			onDaemonEvent: (event, data) => {
			if (event !== 'log' || !this.compactPending) {
				return;
			}
			const message = typeof data.message === 'string' ? data.message : '';
			if (!message.startsWith('[SESSION_COMPACT_RESULT]')) {
				return;
			}
			try {
				const payload = JSON.parse(message.substring('[SESSION_COMPACT_RESULT]'.length).trim()) as {
					sessionID?: string;
					success?: boolean;
					error?: string;
				};
				if (!payload.success && payload.sessionID !== this.compactSessionId) {
					// 其他会话的错误与本窗口的压缩无关。
					return;
				}
				if (payload.success) {
					this.settleCompact(true);
				} else {
					this.settleCompact(false, payload.error ?? '压缩失败');
				}
			} catch {
				// 忽略无法解析的 marker
			}
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
	 * 关键点：状态栏（"正在检查 opencode serve 状态..."）必须等到 serve 真正
	 * 就绪才消失，而不是 daemon 进程一拉起就消失——否则会出现「首次加载历史会话
	 * 时 serve 尚在预热、listMessages 打到冷 serve 返回空消息」的竞态。
	 *
	 * 协议：updateDaemonStatus 事件携带 { alive, serveReady }：
	 * - alive=false  → 立即置 daemonStatusLoaded=true，webview 切到「未运行」态可重试；
	 * - alive=true   → 先发 {serveReady:false}（保持 loading 转圈），再异步等待
	 *                  opencode serve 真正就绪后才发 {serveReady:true} 让状态栏消失。
	 */
	private sendDaemonStatus(): void {
		const daemon = this.context.getDaemon();
		const alive = daemon?.isAlive() ?? false;

		if (!alive) {
			// serve 进程都没起来，无需等待，直接进入「未运行」态。
			this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false }));
			return;
		}

		// 先发 loading 态，让状态栏继续显示「正在检查...」。
		this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: true, serveReady: false }));

		// 异步等待 serve 就绪。复用 opencode.preconnect（内部 _ensureReady 会
		// 轮询健康检查直到 serve 真正可查，幂等、可重复调用）。
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		daemon!.request(
			'opencode.preconnect',
			{ cwd: directory },
			{
				onLine: () => {},
				onError: () => {
					// serve 起不来（如二进制缺失）：落到「未运行」态，让用户可点重试，
					// 而不是无限 loading 转圈。
					this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false }));
				},
				onComplete: (success: boolean) => {
					if (success) {
						// serve 真正就绪：发最终信号让状态栏消失。
						this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: true, serveReady: true }));
					} else {
						// serve 未能就绪：同样落到「未运行」可重试态。
						this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false }));
					}
				},
			},
		);
	}

	private sendLinkifyCapabilities(): void {
		this.callJavaScript(
			'updateLinkifyCapabilities',
			JSON.stringify({ classNavigationEnabled: false, linkifyCapabilities: { file: true, line: true, url: true } }),
		);
	}
}
