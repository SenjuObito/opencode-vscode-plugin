/**
 * HistoryHandler — port of cc-gui `handler/history/HistoryHandler.java`
 * (opencode-only subset). History is a host-side index over sessions the
 * extension created via the persistent daemon.
 *
 *   load_history_data → `window.setHistoryData({ success, sessions, total })`
 *   load_session       → reset current session（SDK listMessages 全量恢复在 Phase 4）
 *   delete_session(s) / toggle_favorite / update_title → 更新索引
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { convertSdkMessages, extractSubagentTranscript } from '../session/SdkMessageConverter';
import { truncateRawForTransport } from '../util/MessageJsonConverter';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { HOST_WINDOW_MESSAGES } from '../session/SessionState';
import { RESTORE_PAGE_MESSAGES } from '../session/OpenCodeSession';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import {
	getFavorites,
	getSessions,
	pushHistoryData,
	setSessions as storeSessions,
	setFavorites as storeFavorites,
	upsertSessionSummary,
	type HistorySessionSummary,
} from '../session/SessionHistoryStore';

const SUPPORTED_TYPES = [
	'load_history_data',
	'load_session',
	'delete_session',
	'delete_sessions',
	'toggle_favorite',
	'update_title',
	'load_subagent_session',
	'load_earlier_messages',
	'set_earlier_cursor',
];

/** 与 webview ReasoningEffort 取值一致（variant → 推理力度为恒等映射）。 */
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 子代理轮询的 tail 窗口（消息条数）：运行中的 task tool_result 落在 transcript 尾部。 */
const SUBAGENT_POLL_TAIL_MESSAGES = 200;

export class HistoryHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'load_history_data':
				this.handleLoadHistoryData();
				return true;
			case 'load_session':
				this.handleLoadSession(content);
				return true;
			case 'delete_session':
				this.handleDeleteSession(content);
				return true;
			case 'delete_sessions':
				this.handleDeleteSessions(content);
				return true;
			case 'toggle_favorite':
				this.handleToggleFavorite(content);
				return true;
		case 'update_title':
			this.handleUpdateTitle(content);
			return true;
		case 'load_subagent_session':
			this.handleLoadSubagentSession(content);
			return true;
		case 'load_earlier_messages':
			this.handleLoadEarlierMessages(content);
			return true;
		case 'set_earlier_cursor':
			this.handleSetEarlierCursor(content);
			return true;
		default:
			return false;
		}
	}

	private getSessions(): HistorySessionSummary[] {
		return getSessions(this.context.getSettingsService().getStore());
	}

	private setSessions(sessions: HistorySessionSummary[]): void {
		storeSessions(this.context.getSettingsService().getStore(), sessions);
	}

	private getFavorites(): Record<string, { favoritedAt: number }> {
		return getFavorites(this.context.getSettingsService().getStore());
	}

	private setFavorites(favorites: Record<string, { favoritedAt: number }>): void {
		storeFavorites(this.context.getSettingsService().getStore(), favorites);
	}

	/** 由 OpenCodeSession 在 turn 结束时调用：登记/更新会话摘要（原生模式由 OpenCode 服务端接管）。 */
	recordSession(_sessionId: string, _title: string, _messageCount: number, _model?: string): void {
		// Native OpenCode server persists sessions automatically
	}

	private handleLoadHistoryData(): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.callJavaScript(
				'setHistoryData',
				JSON.stringify({ success: false, error: 'No daemon connection', sessions: [], total: 0, favorites: {} }),
			);
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		daemon.request('opencode.listSessions', { directory }, {
			onLine: (line) => chunks.push(line),
			onError: (err) => {
				this.callJavaScript(
					'setHistoryData',
					JSON.stringify({ success: false, error: typeof err === 'string' ? err : 'Failed to list sessions', sessions: [], total: 0, favorites: {} }),
				);
			},
			onComplete: (success) => {
				if (!success) {
					this.callJavaScript(
						'setHistoryData',
						JSON.stringify({ success: false, error: 'Failed to list sessions', sessions: [], total: 0, favorites: {} }),
					);
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
				const favorites: Record<string, { favoritedAt: number }> = {};
				const sessions = (rawSessions as Array<Record<string, any>>).map((s) => {
					const sessionId = String(s?.id || s?.sessionId || '');
					const title = String(s?.title || 'Untitled session');
					let lastTimestamp: string | undefined = undefined;
					if (s?.time && typeof s.time === 'object') {
						let updated = typeof s.time.updated === 'number' ? s.time.updated : (typeof s.time.created === 'number' ? s.time.created : 0);
						if (updated > 0) {
							if (updated < 100_000_000_000) {
								updated *= 1000;
							}
							lastTimestamp = new Date(updated).toISOString();
						}
					} else if (typeof s?.lastTimestamp === 'string') {
						lastTimestamp = s.lastTimestamp;
					}

					let model: string | undefined = undefined;
					if (s?.model && typeof s.model === 'object') {
						const p = s.model.providerID || '';
						const m = s.model.id || '';
						model = p && m ? `${p}/${m}` : m;
					} else if (typeof s?.model === 'string') {
						model = s.model;
					}

					const agent = typeof s?.agent === 'string' ? s.agent : undefined;
					const meta = s?.metadata && typeof s.metadata === 'object' ? s.metadata : {};
					const isFavorited = Boolean(meta.isFavorited);
					let favoritedAt: number | undefined = undefined;
					if (isFavorited) {
						const favTime = typeof meta.favoritedAt === 'number' ? meta.favoritedAt : Date.now();
						favoritedAt = favTime;
						favorites[sessionId] = { favoritedAt: favTime };
					}

					return {
						sessionId,
						title,
						messageCount: 0,
						lastTimestamp,
						model,
						agent,
						provider: 'opencode',
						isFavorited,
						favoritedAt,
					};
				});

				this.callJavaScript(
					'setHistoryData',
					JSON.stringify({
						success: true,
						sessions,
						total: sessions.length,
						favorites,
					}),
				);
			},
		});
	}

	private handleLoadSession(content: string): void {
		let sessionId = (content ?? '').trim();
		try {
			const json = JSON.parse(sessionId) as Record<string, unknown>;
			if (typeof json.sessionId === 'string') {
				sessionId = json.sessionId;
			}
		} catch {
			// content 本身即 sessionId
		}

		const session = this.context.getSession();
		if (!session) {
			return;
		}

		// 会话级模型/模式/推理力度的恢复不再依赖 webview 传入的行内值（历史
		// 快照从不更新，恢复旧值会把用户刚切换的选择覆盖掉——模型回退 bug）。
		// 跨会话加载时由 fetchAndRestoreMessages 从 daemon `session.get` 读
		// opencode 权威状态后推送恢复。

		const daemon = this.context.getDaemon();

		if (session.state.getSessionId() === sessionId) {
			// 已在该会话 —— cc-gui ChatWindowDelegate 的同会话语义是「软刷新」
			// （reloadActiveSessionMessages），绝不静默早退：前端
			// beginSessionTransition 已清屏并上锁，早退会让用户面对空屏直到
			// 15s 安全超时。流式中则 defer：不打断在途回复，只释放前端锁。
			if (!daemon || session.state.isBusy()) {
				this.callJavaScript('historyLoadComplete');
				return;
			}
			// 重发一次 setSessionId 以释放 webview 的 __sessionTransitioning，
			// 否则随后的 updateMessages 会被过渡守卫丢弃。
			this.callJavaScript('setSessionId', sessionId);
			void this.fetchAndRestoreMessages(daemon, session, sessionId, false);
			return;
		}

		if (!daemon) {
			this.finishSessionLoad(session, sessionId);
			return;
		}

		session.resetSession();
		// 无条件设置并推送 sessionId：刚 fork 出的会话不在本地历史缓存里，
		// 若被 if (summary) 门控，webview 的 __sessionTransitioning 过渡锁
		// 永不释放，后续恢复的消息会被守卫全部丢弃（表现为空白对话）。
		session.state.setSessionId(sessionId);
		this.callJavaScript('setSessionId', sessionId);
		const summary = this.getSessions().find((s) => s.sessionId === sessionId);
		if (summary) {
			this.callJavaScript('updateSessionTitle', sessionId, summary.title);
		}

		void this.fetchAndRestoreMessages(daemon, session, sessionId, true);
	}

  /**
   * 全量消息恢复：daemon `opencode.listMessages`（SDK session.messages）→
   * 转 cc-gui 消息形状 → restoreMessages 推送 webview → historyLoadComplete。
   *
   * @param restoreSessionState 跨会话加载为 true：随后从 daemon
   *   `session.get` 拉取权威的 model/mode/reasoningEffort 并推送恢复；
   *   同会话软刷新为 false：不覆盖用户在当前会话里刚做的本地选择。
   */
  /**
   * 消息恢复与会话状态恢复是两次独立的 daemon 往返。daemon 已将只读命令
   * 从全局串行队列中释放出来，两个请求并发下发，避免打开历史对话时排队。
   */
	private async fetchAndRestoreMessages(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
		restoreSessionState: boolean,
	): Promise<void> {
		const tasks: Array<Promise<void>> = [this.requestMessages(daemon, session, sessionId)];
		if (restoreSessionState) {
			tasks.push(this.requestSessionState(daemon, session, sessionId));
		}
		await Promise.all(tasks);
		this.callJavaScript('historyLoadComplete');
	}

	private requestMessages(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
	): Promise<void> {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		// Daemon cold-start may return empty messages on the very first listMessages
		// call after startup (serve not ready, or the session transcript not yet
		// lazily loaded). Retry a few times with a short delay when the response is
		// successful but contains zero messages. Channel-side ensureServerReady()
		// already removes the "serve not ready" case; this covers the remaining
		// "session not loaded yet" window so the first history load is never blank.
		const MAX_EMPTY_RETRIES = 3;
		const EMPTY_RETRY_DELAY_MS = 600;

		const doRequest = (retriesLeft: number): Promise<void> => {
			// tail 窗口保留：只解析并保留最近 HOST_WINDOW_MESSAGES 条——全量
			// transcript 在解析管道中流过即弃，宿主峰值 = 窗口而非全量。
			const collector = new ListMessagesCollector({
				mode: 'tail',
				messageLimit: HOST_WINDOW_MESSAGES,
			});
			return new Promise<void>((resolve) => {
				const ok = daemon.request('opencode.listMessages', { sessionId, directory }, {
					onLine: (line) => collector.onLine(line),
					onError: () => resolve(),
					onComplete: (success) => {
						collector.reconcileFallback();
						const messages = convertSdkMessages(collector.getEntries());
						if (messages.length > 0) {
							session.restoreMessages(messages, {
								firstIndex: collector.getFirstRetainedMessageIndex(),
								total: collector.getTotalMessageCount(),
							});
							resolve();
							return;
						}
						// Empty messages + retries remaining → delay and retry
						if (success && retriesLeft > 0) {
							setTimeout(() => {
								doRequest(retriesLeft - 1).then(resolve);
							}, EMPTY_RETRY_DELAY_MS);
							return;
						}
						// 恢复会话后同步 revert（redo）状态，供前端渲染撤销占位条 / 恢复按钮
						const revertState = session.state.getRevertState();
						this.callJavaScript(
							'onRevertStateUpdate',
							JSON.stringify({
								hasRevert: !!revertState,
								messageId: revertState?.messageID || null,
							}),
						);
						resolve();
					},
				});
				if (!ok) {
					resolve();
				}
			});
		};

		return doRequest(MAX_EMPTY_RETRIES);
	}

	private requestSessionState(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			this.fetchAndRestoreSessionState(daemon, session, sessionId, resolve);
		});
	}

	/**
	 * 从 daemon `session.get` 读取 opencode 权威会话状态并恢复：
	 * model {providerID, id, variant} → webview 模型串 + 推理力度，
	 * agent → permissionMode（plan / build→default；自定义 agent 不动 UI）。
	 * 同时回写宿主 SessionState，保证后续 send 使用一致状态。
	 * 无论成功失败都以 historyLoadComplete 收尾（释放前端过渡锁/去抖守卫）。
	 */
	private fetchAndRestoreSessionState(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
		done?: () => void,
	): void {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		const finish = (): void => {
			if (done) {
				done();
				return;
			}
			this.callJavaScript('historyLoadComplete');
		};
		const ok = daemon.request('opencode.getSessionInfo', { sessionId, directory }, {
			onLine: (line) => chunks.push(line),
			onError: () => finish(),
			onComplete: (success) => {
				if (success) {
					try {
						const payload = this.extractJsonObject(chunks.join('\n'));
						const info = payload?.session as {
							agent?: string;
							title?: string;
							model?: { providerID?: string; id?: string; variant?: string };
						} | undefined;

						// 服务端权威标题：本地历史缓存缺失（如刚 fork 的会话）时
						// 补推给 webview，并回填缓存，保证会话列表可同步。
						const serverTitle = typeof info?.title === 'string' ? info.title.trim() : '';
						if (serverTitle && !this.getSessions().some((s) => s.sessionId === sessionId)) {
							upsertSessionSummary(this.context.getSettingsService().getStore(), sessionId, serverTitle);
							this.callJavaScript('updateSessionTitle', sessionId, serverTitle);
						}

						const providerId = typeof info?.model?.providerID === 'string' ? info.model.providerID.trim() : '';
						const modelId = typeof info?.model?.id === 'string' ? info.model.id.trim() : '';
						const variant = typeof info?.model?.variant === 'string' ? info.model.variant.trim() : '';
						const modelStr = providerId && modelId ? `${providerId}/${modelId}` : modelId;

						const restored: { model?: string; permissionMode?: string; reasoningEffort?: string } = {};
						if (modelStr) {
							session.state.setModel(modelStr);
							restored.model = modelStr;
						}
						const agent = typeof info?.agent === 'string' ? info.agent.trim() : '';
						if (agent === 'plan' || agent === 'build') {
							const mode = agent === 'plan' ? 'plan' : 'default';
							session.state.setPermissionMode(mode);
							restored.permissionMode = mode;
						}
						if (variant && REASONING_EFFORTS.includes(variant)) {
							session.state.setReasoningEffort(variant);
							restored.reasoningEffort = variant;
						}

						if (Object.keys(restored).length > 0) {
							this.callJavaScript('onSessionStateRestored', JSON.stringify(restored));
						}
					} catch (err) {
						console.error('[HistoryHandler] Failed to parse getSessionInfo response:', err);
					}
				}
				finish();
			},
		});
		if (!ok) {
			finish();
		}
	}

	private finishSessionLoad(session: OpenCodeSession, sessionId: string): void {
		session.resetSession();
		session.state.setSessionId(sessionId);
		this.callJavaScript('setSessionId', sessionId);
		const summary = this.getSessions().find((s) => s.sessionId === sessionId);
		if (summary) {
			this.callJavaScript('updateSessionTitle', sessionId, summary.title);
		}
		this.callJavaScript('historyLoadComplete');
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
				if (obj && (obj.messages !== undefined || obj.success !== undefined)) {
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

	/**
	 * webview 上滚到顶请求更早的历史（opencode 恢复分页）。
	 * payload: { sessionId?, count? }——sessionId 不匹配当前会话时忽略。
	 */
	private handleLoadEarlierMessages(content: string): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		let sessionId = '';
		let count = RESTORE_PAGE_MESSAGES;
		try {
			const json = JSON.parse(content ?? '{}') as Record<string, unknown>;
			if (typeof json?.sessionId === 'string') {
				sessionId = json.sessionId;
			}
			if (typeof json?.count === 'number' && Number.isFinite(json.count) && json.count > 0) {
				count = Math.min(Math.floor(json.count), 1000);
			}
		} catch {
			// 无 payload / 非 JSON —— 使用默认页大小
		}
		const current = session.state.getSessionId();
		if (sessionId && current && sessionId !== current) {
			return;
		}
		void session.loadEarlierMessages(count);
	}

	/**
	 * webview 裁剪分页累积（超上限丢最老页）后回滚游标：被裁掉的区间
	 * 下次「加载更早」时重新回源，保证不出现取不到的空档。
	 */
	private handleSetEarlierCursor(content: string): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		try {
			const json = JSON.parse(content ?? '{}') as Record<string, unknown>;
			const sessionId = typeof json?.sessionId === 'string' ? json.sessionId : '';
			const cursor = typeof json?.cursor === 'number' ? json.cursor : Number.NaN;
			const current = session.state.getSessionId();
			if (sessionId && current && sessionId !== current) {
				return;
			}
			if (Number.isFinite(cursor)) {
				session.setEarlierCursor(cursor);
			}
		} catch {
			// 忽略畸形 payload
		}
	}

	private handleDeleteSession(content: string): void {
		const sessionId = (content ?? '').trim();
		if (!sessionId) {
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		daemon.request('opencode.deleteSession', { sessionId, directory }, {
			onLine: () => {},
			onError: (err) => {
				console.error('[HistoryHandler] Failed to delete session:', err);
			},
			onComplete: () => {
				this.handleLoadHistoryData();
			},
		});
	}

	private handleDeleteSessions(content: string): void {
		let ids: string[] = [];
		try {
			const parsed = JSON.parse(content) as unknown;
			if (Array.isArray(parsed)) {
				ids = parsed.filter((i): i is string => typeof i === 'string');
			} else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessionIds?: unknown }).sessionIds)) {
				ids = ((parsed as { sessionIds: unknown[] }).sessionIds).filter((i): i is string => typeof i === 'string');
			}
		} catch {
			ids = content ? [content] : [];
		}
		const idSet = new Set(ids);
		if (idSet.size === 0) {
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const promises = Array.from(idSet).map((sessionId) => {
			return new Promise<void>((resolve) => {
				daemon.request('opencode.deleteSession', { sessionId, directory }, {
					onLine: () => {},
					onError: () => resolve(),
					onComplete: () => resolve(),
				});
			});
		});
		Promise.all(promises).then(() => {
			this.handleLoadHistoryData();
		});
	}

	private handleToggleFavorite(content: string): void {
		const sessionId = (content ?? '').trim();
		if (!sessionId) {
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		daemon.request('opencode.toggleFavorite', { sessionId, directory }, {
			onLine: () => {},
			onError: (err) => {
				console.error('[HistoryHandler] Failed to toggle favorite:', err);
			},
			onComplete: (success) => {
				if (success) {
					console.log('[HistoryHandler] Favorite toggled successfully:', sessionId);
				}
			},
		});
	}

	private handleUpdateTitle(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const sessionId = typeof json?.sessionId === 'string' ? json.sessionId : '';
			const title = typeof json?.title === 'string' ? json.title : (typeof json?.customTitle === 'string' ? json.customTitle : '');
			if (!sessionId || !title) {
				return;
			}
			const daemon = this.context.getDaemon();
			if (!daemon) {
				return;
			}
			const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
			daemon.request('opencode.updateSessionTitle', { sessionId, title, directory }, {
				onLine: () => {},
				onError: (err) => {
					console.error('[HistoryHandler] Failed to update session title:', err);
				},
				onComplete: (success) => {
					if (success) {
						this.callJavaScript('updateSessionTitle', sessionId, title);
						this.handleLoadHistoryData();
					}
				},
			});
		} catch {
			// 忽略解析失败
		}
	}

	/**
	 * Load a subagent's transcript via the OpenCode daemon.
	 *
	 * OpenCode does NOT expose subagent sidechains as separate sessions (the
	 * sessionId carried by the webview is the *parent* session). The subagent's
	 * invocation and result live inside the parent session as a `tool_use` block
	 * (id === toolUseId, for the task/skill tool) and its `tool_result`. So we
	 * fetch the parent session's messages from the daemon, then extract the
	 * subagent's portion by toolUseId and push it to the webview.
	 *
	 * On success the response is `completed: true` (stopping the UI poll); while
	 * the subagent is still running and its tool_result has not been written yet
	 * we return `status: 'running'` so the webview keeps polling. A daemon error
	 * surfaces a single, truthful failure (never the old stub's misleading
	 * "not available from OpenCode daemon" message, which lied — the plugin had
	 * never actually contacted the daemon).
	 */
	private handleLoadSubagentSession(content: string): void {
		const send = (payload: Record<string, unknown>): void => {
			this.callJavaScript('onSubagentHistoryLoaded', JSON.stringify(payload));
		};

		let toolUseId = '';
		let agentId = '';
		let agentPath = '';
		let sessionId = '';
		let provider = 'opencode';
		let isPoll = false;
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			toolUseId = typeof json?.toolUseId === 'string' ? json.toolUseId : '';
			agentId = typeof json?.agentId === 'string' ? json.agentId : '';
			agentPath = typeof json?.agentPath === 'string' ? json.agentPath : '';
			sessionId = typeof json?.sessionId === 'string' ? json.sessionId : '';
			provider = typeof json?.provider === 'string' ? json.provider : 'opencode';
			isPoll = json?.poll === true;
		} catch {
			// Ignore malformed payloads
			return;
		}

		const base = { toolUseId, agentId, agentPath, sessionId, provider };

		const daemon = this.context.getDaemon();
		if (!daemon) {
			send({
				...base,
				success: false,
				status: 'completed',
				completed: true,
				error: 'No daemon connection',
				messages: [],
			});
			return;
		}

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		// 轮询（每 2s 一次）只保留 transcript 尾部窗口：运行中的 task 结果一定
		// 在尾部，全量解析转换是轮询日志刷屏与内存峰值的来源。用户主动点开
		// （可能查看很早的子代理）仍走全量。
		const collector = isPoll
			? new ListMessagesCollector({ mode: 'tail', messageLimit: SUBAGENT_POLL_TAIL_MESSAGES })
			: new ListMessagesCollector();
		let finished = false;
		const finish = (payload: Record<string, unknown>): void => {
			if (finished) { return; }
			finished = true;
			send(payload);
		};

		daemon.request('opencode.listMessages', { sessionId, directory }, {
			onLine: (line) => collector.onLine(line),
			// request() (OpenCodeDaemonBridge) fires onError then onComplete on a
			// terminal failure, or onError only on a synchronous failure. The
			// `finished` guard guarantees exactly one response to the webview.
			onError: (error) => {
				finish({
					...base,
					success: false,
					status: 'completed',
					completed: true,
					error: typeof error === 'string' ? error : 'Failed to fetch subagent transcript',
					messages: [],
				});
			},
			onComplete: (success) => {
				if (!success) {
					finish({
						...base,
						success: false,
						status: 'completed',
						completed: true,
						error: 'Failed to fetch subagent transcript',
						messages: [],
					});
					return;
				}
				collector.reconcileFallback();
				const messages = convertSdkMessages(collector.getEntries());
				const transcript = extractSubagentTranscript(messages, toolUseId);
				if (transcript.messages.length === 0) {
					// Subagent not present in the session transcript yet (still
					// running, or opencode did not surface it). Keep the loading
					// state so the webview can poll again — do NOT report a false error.
					finish({ ...base, success: true, status: 'running', completed: false, messages: [] });
					return;
				}
				finish({
					...base,
					success: true,
					status: 'completed',
					completed: true,
					// 与消息恢复路径同因：子代理 transcript 可能携带大 tool_result，
					// 推送前按传输截断规则裁剪（tool_result 20K / 错误文本 1K）。
					messages: transcript.messages.map((m) =>
						m && typeof m === 'object' ? truncateRawForTransport(m as Record<string, unknown>) : m,
					),
					resultText: transcript.resultText,
				});
			},
		});
	}
}
