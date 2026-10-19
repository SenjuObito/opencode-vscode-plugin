/**
 * WindowEventHandler — port of cc-gui `handler/WindowEventHandler.java`.
 * Handles window-level events: heartbeat, create_new_session, frontend_ready,
 * refresh_slash_commands, history_dom_committed.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { logDiagnostic, logDiagnosticBlock } from '../util/DiagnosticLogger';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { pushHistoryData, upsertSessionSummary } from '../session/SessionHistoryStore';
import { pushUserLanguageConfig, pushUiPreferences, pushPinnedModels } from './SettingsHandler';
import { updateModelContextWindows } from '../util/ModelContextWindowCatalog';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import { resyncSessionFromServerIfNeeded } from '../session/SessionResync';

/**
 * webview → 宿主的消息 envelope。
 *
 * 多会话后前端统一发 `{"sessionId":..., "messageId":...}`，但历史上也发过
 * 裸 messageId / 裸 `full`。两者都要认，否则连字符串会被当成消息 ID 直接
 * 发给 daemon（对应 idea `WindowEventHandler.handleRevertSession` 的解析分支）。
 */
interface MessageEnvelope {
	sessionId?: string;
	messageId?: string;
	isFull?: boolean;
}

function parseMessageEnvelope(content: string | undefined): MessageEnvelope {
	const raw = (content ?? '').trim();
	if (raw === '') {
		return {};
	}
	if (!raw.startsWith('{')) {
		return raw === 'full' ? { isFull: true } : { messageId: raw };
	}
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const sessionId = typeof obj.sessionId === 'string' && obj.sessionId.trim() !== ''
			? obj.sessionId.trim()
			: undefined;
		const messageId = typeof obj.messageId === 'string'
			? obj.messageId
			: (typeof obj.messageID === 'string' ? obj.messageID : undefined);
		return {
			sessionId,
			messageId: messageId?.trim() ? messageId : undefined,
			isFull: obj.type === 'full',
		};
	} catch {
		// 非法 JSON：按旧版裸 messageId 处理
		return { messageId: raw };
	}
}



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
	'switch_session',
	'close_session',
	'refresh_editor_context',
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
				this.handleCreateNewSession(content);
				return true;
			case 'switch_session':
				this.handleSwitchSession(content);
				return true;
			case 'close_session':
				this.handleCloseSession(content);
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
			// 用户在「OpenCode serve 未运行」提示上点重试：重新拉起并探测等待 serve 就绪。
			void this.handleCheckDaemonStatus();
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
				this.handleUnrevertSession(content);
				return true;
			case 'fork_session':
				this.handleForkSession(content);
				return true;
			case 'compact_session':
				this.handleCompactSession(content);
				return true;
			case 'refresh_editor_context':
				this.handleRefreshEditorContext(content);
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

	private handleCreateNewSession(content?: string): void {
		let clientSessionId: string | undefined;
		if (content) {
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				clientSessionId = (parsed.sessionId || parsed.clientSessionId) as string | undefined;
			} catch {
				clientSessionId = content.trim() || undefined;
			}
		}
		const sessionManager = this.context.getSessionManager();
		if (sessionManager) {
			sessionManager.createNewSession(clientSessionId);
		} else {
			const session = this.context.getSession();
			session?.resetSession();
			this.callJavaScript('showLoading', clientSessionId ?? '', 'false');
			this.callJavaScript('historyLoadComplete');
		}
	}

	private handleSwitchSession(content: string): void {
		let targetSessionId: string | undefined;
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			targetSessionId = (parsed.sessionId || parsed.tabId) as string | undefined;
		} catch {
			targetSessionId = content.trim() || undefined;
		}
		const sessionManager = this.context.getSessionManager();
		if (!targetSessionId || !sessionManager) {
			return;
		}
		const session = sessionManager.switchToSession(targetSessionId);
		void this.hydrateTabSession(session, targetSessionId);
	}

	/**
	 * 视图内切 tab 时的宿主 → 视图同步（idea `selectionChanged` 分支的等价物）。
	 *
	 * 顺序照 idea：先水化（视图立刻拿到权威快照，不再信任自己残留的数组），
	 * 空闲时再与服务端对账，有变化则二次水化。
	 *
	 * 注意 `switchToSession` 已经异步推过 `setSessionId`，这里的水化包同样带
	 * sessionId，前端会按 sessionId 判断前台/后台，不会把 A 的消息写进 B 的列表。
	 */
	private async hydrateTabSession(session: OpenCodeSession, targetSessionId: string): Promise<void> {
		if (session.state.getSessionId() !== targetSessionId) {
			// switchToSession 期间的并发切换：这次水化已经过期。
			return;
		}
		// 流式中的会话不水化：宿主 state 与视图的增量累加器可能还差一拍，整份
		// 替换会把已渲染的半截文本吞掉。视图自己保存的快照 + 归档运行时足够续上。
		if (session.state.isBusy()) {
			return;
		}
		session.hydrateSessionToWebview();
		const updated = await session.reconcileWithServer();
		// 对账是异步的，期间用户可能又切走了。
		if (updated && session.state.getSessionId() === targetSessionId) {
			session.hydrateSessionToWebview();
		}
	}

	private handleCloseSession(content: string): void {
		let targetSessionId: string | undefined;
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			targetSessionId = (parsed.sessionId || parsed.tabId) as string | undefined;
		} catch {
			targetSessionId = content.trim() || undefined;
		}
		if (targetSessionId) {
			this.context.getSessionManager()?.closeSession(targetSessionId);
		}
	}

	/** 只回给发起 `frontend_ready` 的那个视图（实例与视图是 1:N）。 */
	private reply(functionName: string, ...args: string[]): void {
		this.context.callJavaScriptToOrigin(functionName, ...args);
	}

	/** frontend_ready：把权威状态回放给刚就绪的视图。 */
	private handleFrontendReady(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		// 从这里开始 callJavaScript 才有着落（webview 已挂好监听）。
		this.context.setFrontendReady(true);
		// 按视图记录就绪：新建标签这类「只该发生一次」的动作要挑一个已挂载的
		// 视图投递，不能广播（否则每个窗口都会各建一个空标签）。
		this.context.markViewReady(this.context.getDispatchOrigin());

		// 单实例之后，视图就绪不再是「来了一个空对话」——它是同一个实例的
		// 又一个窗口。因此这里**绝不能**重置共享会话，只补一份权威快照。
		this.reply(
			'applyBackendTabState',
			JSON.stringify({
				provider: 'opencode',
				model: session.state.getModel() ?? '',
				permissionMode: session.state.getPermissionMode(),
				reasoningEffort: session.state.getReasoningEffort(),
			}),
		);

		this.pushActiveProvider();

		this.reply('onModeReceived', session.state.getPermissionMode());

		const sessionId = session.state.getSessionId();
		if (sessionId) {
			this.reply('setSessionId', sessionId);
			// 视图是空的（首次挂载 / 重载）：把宿主权威快照整包补上，含
			// isStreaming 与 revert 边界。
			session.hydrateSessionToWebview({ origin: true });
			// 宿主内存也没有内容（冷启动、serve 未就绪）：从服务端补齐。
			if (session.state.getMessages().length === 0) {
				void resyncSessionFromServerIfNeeded(session, {
					frontendReady: true,
				}).then((outcome) => {
					if (outcome !== 'skipped') {
						logDiagnostic(`[frontend_ready] session resync: ${outcome}`);
					}
				});
			}
		}

		this.handleRefreshSlashCommands();
		void this.sendDaemonStatus();
		this.sendLinkifyCapabilities();

		// 语言回放：手动设置过 → source 'user'；否则跟随 IDE 界面语言。
		// webview 的 applyIdeaLanguageConfig 会 changeLanguage 并写 localStorage。
		pushUserLanguageConfig((fn, ...args) => this.reply(fn, ...args), this.context.getSettingsService());

		// UI 偏好回放（主题 / 字号 / 配色 / diff / 行为开关）：webview 的
		// localStorage 在 VS Code 重建 webview 后会丢，宿主才是权威源。
		pushUiPreferences((fn, ...args) => this.reply(fn, ...args), this.context.getSettingsService());

		// 置顶模型回放（跨会话持久化）
		pushPinnedModels((fn, ...args) => this.reply(fn, ...args), this.context.getSettingsService());

		// 字体配置回放（编辑器字体、已保存的 UI 字体与代码字体）
		this.context.pushFontConfig();

		// 推送当前编辑器上下文（需在 webview JS 就绪后调用）。
		this.context.pushEditorContext();
	}

	/**
	 * webview 切换 tab / 在 tab 内打开或关闭文件上下文时，把当前编辑器上下文
	 * 只同步到该视图：enabled=true 补推当前文件，false 清空 chip。
	 * 与全局设置无关，设置值只用于新 tab 的初始状态。
	 */
	private handleRefreshEditorContext(content: string): void {
		let enabled = true;
		if (content) {
			try {
				const payload = JSON.parse(content) as { enabled?: unknown };
				if (typeof payload?.enabled === 'boolean') {
					enabled = payload.enabled;
				}
			} catch {
				// 兼容裸布尔 / 空内容：默认按开启处理
			}
		}
		this.context.refreshEditorContext(enabled);
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
				if (obj && (obj.commands !== undefined || obj.models !== undefined || obj.success !== undefined)) {
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

	private handleCompactSession(content?: string): void {
		const daemon = this.context.getDaemon();
		const envelope = parseMessageEnvelope(content);
		const session = this.resolveSession(envelope.sessionId);
		if (!daemon || !session) {
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			return;
		}

		// 前端可能显式指定压缩用的模型（{sessionId, model}）；否则用会话当前的模型。
		let requestedModel: string | undefined;
		if (content && content.trim().startsWith('{')) {
			try {
				const parsed = JSON.parse(content) as { model?: unknown };
				if (typeof parsed?.model === 'string' && parsed.model.trim() !== '') {
					requestedModel = parsed.model.trim();
				}
			} catch {
				// 忽略非法 JSON
			}
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
			// summarize 端点要求 body { providerID, modelID }，具体由 daemon 组装；
			// undefined 表示由 daemon 回退到会话运行时记录的模型。
			model: requestedModel ?? session.state.getModel() ?? undefined,
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
		const targetSessionId = this.compactSessionId ?? '';
		this.clearCompactState();
		if (success) {
			this.callJavaScript('onCompactSuccess', targetSessionId);
		} else {
			// showError 只在设置视图注册；对话视图用 onCompactError toast。
			this.callJavaScript('onCompactError', targetSessionId, detail ?? '');
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
				if (event === 'engine_status') {
					this.pushDaemonStatus(daemon.isAlive(), daemon.isAlive());
					return;
				}
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

	private handleRevertSession(content: string): void {
		const daemon = this.context.getDaemon();
		const envelope = parseMessageEnvelope(content);
		const session = this.resolveSession(envelope.sessionId);
		logDiagnostic(`[revert] request messageId="${envelope.messageId ?? ''}" session=${envelope.sessionId ?? '(active)'} daemon=${!!daemon}`);
		if (!daemon || !session) {
			if (!session && envelope.sessionId) {
				this.callJavaScript('onRevertError', JSON.stringify({ op: 'undo', error: 'unknown session' }));
			}
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			logDiagnostic('[revert] skipped: no active sessionId');
			this.callJavaScript('onRevertError', JSON.stringify({ op: 'undo', error: 'no active session' }));
			return;
		}

		this.withMessageId(daemon, sessionId, envelope.messageId ?? '', '[revert]', (resolvedId) => {
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
					this.pushRevertStateFromResponse(sessionId, chunks.join('\n'), resolvedId);
				},
			});
		});
	}

	private handleUnrevertSession(content?: string): void {
		const daemon = this.context.getDaemon();
		const envelope = parseMessageEnvelope(content);
		const session = this.resolveSession(envelope.sessionId);
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
		void daemon.request('opencode.unrevert', { sessionId }, {
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
				this.pushRevertStateFromResponse(sessionId, chunks.join('\n'), null);
			},
		});
	}

	/**
	 * 把 daemon 返回的 revert 状态落到**目标会话**并推给前端。
	 *
	 * 首参带 sessionId：前端 `onRevertStateUpdate` 支持 `(sessionId, json)` 形式，
	 * 只有带上它才能把状态归到正确的 tab（对应 idea `pushRevertStateFromResponse`）。
	 */
	private pushRevertStateFromResponse(
		sessionId: string,
		raw: string,
		fallbackMessageId: string | null,
	): void {
		const payload = this.extractJsonObject(raw);
		const sessionObj = payload?.session as Record<string, unknown> | undefined;
		const revert = (sessionObj?.revert ?? payload?.revert ?? null) as { messageID?: string } | null;
		const revertMessageId = revert && typeof revert.messageID === 'string' && revert.messageID !== ''
			? revert.messageID
			: null;
		const messageId = revertMessageId ?? fallbackMessageId;
		const hasRevert = revertMessageId !== null || fallbackMessageId !== null;
		logDiagnostic(`[revert-state] session=${sessionId} hasRevert=${hasRevert} messageId=${messageId ?? 'null'}`);
		// 记录到目标会话：切换/恢复会话后可重新推送给前端
		// 用精确 id 查询（不回退），否则并发关闭会话时会把状态写到别人身上。
		this.context.getSession(sessionId)?.state.setRevertState(
			hasRevert && messageId ? { messageID: messageId } : null,
		);
		this.callJavaScript('onRevertStateUpdate', sessionId, JSON.stringify({
			hasRevert,
			messageId,
		}));
	}


	/**
	 * 按 envelope 的 sessionId 取会话。
	 *
	 * 没带 sessionId（旧版前端）→ 回退到窗口当前会话，行为不变。
	 * 带了却查不到 → 返回 null：宁可让这次操作失败，也不能把撤销/fork 落到
	 * 另一个对话上（那会直接改坏别的 tab 的消息）。
	 */
	private resolveSession(sessionId: string | undefined): OpenCodeSession | null {
		const id = sessionId?.trim();
		if (!id) {
			return this.context.getSession();
		}
		const scoped = this.context.getSession(id);
		if (!scoped) {
			logDiagnostic(`[session] unknown sessionId="${id}" — aborting instead of falling back`);
		}
		return scoped;
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
		// 逐行解析（daemon listMessages 为逐条 NDJSON 输出），不缓存原始行。
		const collector = new ListMessagesCollector();
		void daemon.request('opencode.listMessages', { sessionId, directory }, {
			onLine: (line) => collector.onLine(line),
			onError: (error) => {
				logDiagnostic(`[${label}] listMessages FAILED error=${error}`);
			},
			onComplete: (success) => {
				if (!success) {
					logDiagnostic(`[${label}] listMessages failed — abort`);
					return;
				}
				collector.reconcileFallback();
				let latestUserId: string | null = null;
				for (const entry of collector.getEntries() as Array<Record<string, unknown>>) {
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

	private handleForkSession(content: string): void {
		const daemon = this.context.getDaemon();
		const envelope = parseMessageEnvelope(content);
		const session = this.resolveSession(envelope.sessionId);
		logDiagnostic(
			`[fork] request messageId="${envelope.messageId ?? ''}" isFull=${!!envelope.isFull} `
			+ `session=${envelope.sessionId ?? '(active)'} daemon=${!!daemon}`,
		);
		if (!daemon || !session) {
			if (!session && envelope.sessionId) {
				this.callJavaScript('onForkError', 'unknown session');
			}
			return;
		}

		const sessionId = session.state.getSessionId();
		if (!sessionId) {
			logDiagnostic('[fork] skipped: no active sessionId');
			this.callJavaScript('onForkError', 'no active session');
			return;
		}

		// 双保险：webview 已在流式期间禁用 fork 按钮，这里兜底拒绝。
		// daemon 命令队列会把 fork 排队到回合结束，且流式中 fork 出的是不完整快照。
		if (session.state.isBusy()) {
			logDiagnostic('[fork] skipped: session busy');
			this.callJavaScript('onForkError', 'session busy');
			return;
		}

		// 双语义：'full' / {type:'full'} = 全量复制（不带 messageID）；其余 = 从指定
		// 消息处分叉（服务端 exclusive 语义，不含该条）。空/'latest' 交由
		// withMessageId 解析为最后一条用户消息。
		if (envelope.isFull) {
			this.requestFork(daemon, sessionId, undefined);
			return;
		}

		this.withMessageId(daemon, sessionId, envelope.messageId ?? '', '[fork]', (resolvedId) => {
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

	private sendDaemonStatusInFlight = false;

	private async handleCheckDaemonStatus(): Promise<void> {
		const daemon = this.context.getDaemon();
		if (daemon && !daemon.isAlive() && !daemon.isStarting()) {
			await daemon.start();
		}
		await this.sendDaemonStatus();
	}

	/**
	 * 向 webview 推送 daemon / serve / models 就绪状态。
	 *
	 * 关键点：状态栏（"正在检查 opencode serve 状态..."）必须等到：
	 * 1. opencode serve 进程成功启动且连通；
	 * 2. 模型列表成功从 opencode serve 获取并推送给 webview；
	 * 两个阶段均完成之后，才发 { alive: true, serveReady: true } 让状态栏消失。
	 *
	 * 若任一阶段失败（如 CLI 缺失、serve 退出、模型列表为空/报错）：
	 * 立即推送 { alive: false, serveReady: false } 切到「未运行」可重试态，展示失败与重试按钮。
	 */
	private pushDaemonStatus(alive: boolean, serveReady: boolean, extra?: Record<string, unknown>): void {
		const daemon = this.context.getDaemon();
		const engine = daemon?.getEngineStatus() ?? null;
		this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive, serveReady, engine, ...extra }));
	}

	private async sendDaemonStatus(): Promise<void> {
		if (this.sendDaemonStatusInFlight) {
			return;
		}
		this.sendDaemonStatusInFlight = true;

		try {
			const daemon = this.context.getDaemon();
			if (!daemon) {
				this.pushDaemonStatus(false, false);
				return;
			}

			// 1. 先发 loading 态，让状态栏保持转圈显示「正在检查...」
			this.pushDaemonStatus(true, false);

			// 若 daemon 正在启动中或尚未存活，等待启动完成
			if (daemon.isStarting() || !daemon.isAlive()) {
				const started = await daemon.start();
				if (!started || !daemon.isAlive()) {
					this.pushDaemonStatus(false, false);
					return;
				}
			}

			// 2. 阶段一：异步等待 serve 就绪（opencode.preconnect）
			const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
			const preconnectOk = await new Promise<boolean>((resolve) => {
				daemon.request(
					'opencode.preconnect',
					{ cwd: directory },
					{
						onLine: () => {},
						onError: () => resolve(false),
						onComplete: (success: boolean) => resolve(success),
					},
				);
			});

			if (!preconnectOk) {
				// serve 启动失败或异常退出：落到「未运行」可重试态
				this.pushDaemonStatus(false, false);
				return;
			}

			// 3. 阶段二：获取模型列表并校验
			const modelsOk = await this.fetchAndPushModels(daemon, 'opencode');
			if (modelsOk) {
				// serve 真正就绪 且 模型列表成功获取分发：发最终信号让状态栏消失
				this.pushDaemonStatus(true, true);
			} else {
				// 模型列表获取失败：落到「未运行」可重试态
				this.pushDaemonStatus(false, false);
			}
		} finally {
			this.sendDaemonStatusInFlight = false;
		}
	}

	/** 获取模型列表并同步推送到 webview 与上下文窗口目录 */
	private async fetchAndPushModels(daemon: OpenCodeDaemonBridge, provider: string): Promise<boolean> {
		const chunks: string[] = [];
		return new Promise<boolean>((resolve) => {
			daemon.request('opencode.getModels', {}, {
				onLine: (line) => chunks.push(line),
				onError: (error) => {
					this.pushModelError(provider, error);
					resolve(false);
				},
				onComplete: (success) => {
					if (!success) {
						resolve(false);
						return;
					}
					const payload = this.extractJsonObject(chunks.join('\n'));
					if (!payload || payload.success === false) {
						const err = (typeof payload?.error === 'string' && payload.error)
							? payload.error
							: 'No model list returned';
						this.pushModelError(provider, err);
						resolve(false);
						return;
					}
					if (typeof payload.provider !== 'string' || payload.provider === '') {
						payload.provider = provider;
					}
					try {
						updateModelContextWindows(payload);
						this.context.getSession()?.republishUsageFromHistory();
					} catch (e) {
						// ignore catalog update error
					}
					this.callJavaScript('setCliModels', JSON.stringify(payload));
					const models = Array.isArray(payload.models) ? payload.models : [];
					resolve(models.length > 0);
				},
			});
		});
	}

	private pushModelError(provider: string, message: string): void {
		this.callJavaScript(
			'setCliModels',
			JSON.stringify({
				success: false,
				provider: provider ?? 'opencode',
				error: message ?? 'unknown error',
				models: [],
			}),
		);
	}



	private sendLinkifyCapabilities(): void {
		this.callJavaScript(
			'updateLinkifyCapabilities',
			JSON.stringify({ classNavigationEnabled: false, linkifyCapabilities: { file: true, line: true, url: true } }),
		);
	}
}
