/**
 * HistoryHandler — port of idea `handler/history/HistoryHandler.java`
 * (opencode-only subset). History is a host-side index over sessions the
 * extension created via the persistent daemon.
 *
 * <p>The history view speaks the v2 dotted commands; this handler owns them,
 * exactly like idea's `HistoryHandler` owns `history.delete` /
 * `history.deleteMany` / `history.favorite` / `history.rename`. Export lives
 * in `ExportHandler` (`history.export`). The legacy snake_case names
 * (`delete_session`, `toggle_favorite`, ...) are gone: one command name per
 * operation, no aliases.</p>
 *
 *   history.refresh / history.deepSearch → `window.setHistoryData({ success, sessions, total })`
 *   history.delete / history.deleteMany  → daemon `opencode.deleteSession` + reload
 *   history.favorite                     → daemon `opencode.toggleFavorite` + reload
 *   history.rename                       → daemon `opencode.updateSessionTitle` + `tab.title.changed`
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { convertSdkMessages, extractSubagentTranscript } from '../session/SdkMessageConverter';
import { truncateRawForTransport } from '../util/MessageJsonConverter';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { logError, logWarn } from '../util/DiagnosticLogger';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import {
	getSessions,
	setSessions as storeSessions,
	upsertSessionSummary,
	type HistorySessionSummary,
} from '../session/SessionHistoryStore';

const SUPPORTED_TYPES = [
	'history.refresh',
	'history.deepSearch',
	'history.delete',
	'history.deleteMany',
	'history.favorite',
	'history.rename',
	'load_subagent_session',
];

/**
 * 会话 id 白名单：只允许 opencode 生成的 id 字符集。
 * 与 idea `HistoryDeleteService#isValidSessionId` 一致——id 会进入 SDK 的 URL
 * 路径，`../foo` 这类 payload 不能透传。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 每页历史的消息条数。
 *
 * <p>opencode 2.x 的 `/api/session/{id}/message` 默认页只有 50 条，且拒绝
 * `limit > 200`。打开会话时必须显式要满一页，否则长会话看起来只有最新 50 条。</p>
 */
const HISTORY_PAGE_MESSAGE_LIMIT = 200;

/** 统计用户回合时最多翻多少页（防服务端游标异常导致的无限翻页）。 */
const HISTORY_USER_TURN_PAGE_LIMIT = 50;

/** 一页转录里的用户回合数（`type=user`，工具结果条不算回合）。 */
function countUserTurns(messages: Array<{ type: string }>): number {
	let turns = 0;
	for (const message of messages) {
		if (message.type === 'user') {
			turns += 1;
		}
	}
	return turns;
}

/** 与 webview ReasoningEffort 取值一致（variant → 推理力度为恒等映射）。 */
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 子代理轮询的 tail 窗口（消息条数）：运行中的 task tool_result 落在 transcript 尾部。 */
const SUBAGENT_POLL_TAIL_MESSAGES = 200;

/**
 * 历史列表加载的重试参数。单次尝试超时后由下一次尝试顶掉——daemon 与宿主
 * 都没有逐请求超时，悬挂的请求只能靠「新请求」终止等待。
 */
const HISTORY_ATTEMPT_TIMEOUT_MS = 5_000;
const HISTORY_MAX_ATTEMPTS = 3;
const HISTORY_RETRY_DELAY_MS = 600;

export class HistoryHandler extends BaseMessageHandler {
	/** 历史列表加载序列：每次 history.refresh 递增，用于顶掉过期的重试与回包。 */
	private historyLoadSeq = 0;

	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	/**
	 * v2 `session.load` 的入口（无 legacy 报文可解析）。
	 *
	 * 绑定到目标 tab 的会话由 `SessionManager` 的多 tab 解析器负责，
	 * 这里只做「加载并回放」。
	 */
	loadSessionById(sessionId: string): void {
		if (!sessionId) {
			return;
		}
		this.handleLoadSession(JSON.stringify({ sessionId }));
	}

	/**
	 * 磁盘分页：把该会话更早的一页前插到它所属的 tab。
	 *
	 * <p>与 `session.load` 一样按会话 id 解析归属，不读「当前活跃 tab」：
	 * 事件晚到（用户已经切走）时也要写回发起请求的那个会话。</p>
	 */
	loadEarlierById(sessionId: string): void {
		if (!sessionId) {
			return;
		}
		const daemon = this.context.getDaemon();
		const session = this.context.getSessionBySessionId(sessionId);
		if (!daemon || !session) {
			return;
		}
		const historyWindow = session.historyWindow;
		const generation = historyWindow.beginEarlier();
		if (generation == null) {
			// 已有请求在飞 / 没有更早的页：重推一次状态，让按钮不会卡在 loading。
			session.publishHistoryWindow();
			return;
		}
		const cursor = historyWindow.getEarlierCursor();
		session.publishHistoryWindow();

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const collector = new ListMessagesCollector();
		let settled = false;
		const done = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (!historyWindow.isCurrent(generation)) {
				// tab 已重新加载 / 换绑到别的会话：这一页属于旧转录，丢弃。
				return;
			}
			session.publishHistoryWindow();
		};

		const ok = daemon.request(
			'opencode.listMessages',
			{
				sessionId,
				directory,
				limit: historyWindow.getPageSize() || HISTORY_PAGE_MESSAGE_LIMIT,
				cursor: cursor ?? undefined,
			},
			{
				onLine: (line) => collector.onLine(line),
				onError: () => {
					historyWindow.failEarlier(generation);
					done();
				},
				onComplete: (success) => {
					if (settled) {
						return;
					}
					if (!success) {
						historyWindow.failEarlier(generation);
						done();
						return;
					}
					collector.reconcileFallback();
					const messages = convertSdkMessages(collector.getEntries());
					if (!historyWindow.isCurrent(generation)) {
						settled = true;
						return;
					}
					if (messages.length === 0) {
						// 服务端把这一页过滤成空：没有更早的内容了。
						historyWindow.finishEarlier(generation, {
							loadedCount: 0,
							loadedTurns: 0,
							cursor: null,
							hasEarlier: false,
						});
						done();
						return;
					}
					if (session.state.getSessionId() !== sessionId) {
						// 会话本身已换绑：不要把旧页前插到新转录。
						historyWindow.failEarlier(generation);
						settled = true;
						return;
					}
					const added = session.prependHistoryMessages(messages);
					historyWindow.finishEarlier(generation, {
						loadedCount: added,
						loadedTurns: countUserTurns(messages),
						cursor: collector.getNextCursor(),
						// `hasEarlier` 由 daemon 用 rawCount（过滤前的服务端页大小）
						// 算出。不能再 OR 游标：这个引擎的最后一页也会给 `nextCursor`，
						// OR 上去就永远「还有更早」，要多点一次才收口。
						hasEarlier: collector.getHasEarlier(),
					});
					done();
				},
			},
		);
		if (!ok) {
			historyWindow.failEarlier(generation);
			done();
		}
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'history.refresh':
			case 'history.deepSearch':
				// 深度搜索在 opencode 侧没有本地缓存可清：重新向 daemon 拉一次列表
				// 就是它的全部语义（idea `handleDeepSearchHistory` 同样实现）。
				this.handleLoadHistoryData();
				return true;
			case 'history.delete':
				this.handleDeleteSession(content);
				return true;
			case 'history.deleteMany':
				this.handleDeleteSessions(content);
				return true;
			case 'history.favorite':
				this.handleToggleFavorite(content);
				return true;
			case 'history.rename':
				this.handleUpdateTitle(content);
				return true;
			case 'load_subagent_session':
				this.handleLoadSubagentSession(content);
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

	/** 删除成功后清掉本地索引里那条摘要（否则历史标题查询会拿到幽灵条目）。 */
	private forgetSessionSummary(sessionId: string): void {
		const remaining = this.getSessions().filter((s) => s.sessionId !== sessionId);
		this.setSessions(remaining);
	}

	/** 由 OpenCodeSession 在 turn 结束时调用：登记/更新会话摘要（原生模式由 OpenCode 服务端接管）。 */
	recordSession(_sessionId: string, _title: string, _messageCount: number, _model?: string): void {
		// Native OpenCode server persists sessions automatically
	}

	/**
	 * 历史列表只在这里加载（webview 的 useHistoryLoader 仅在进入 history 视图时
	 * 请求一次），宿主此前既不重试也不打日志——任何一次静默失败都等于列表永久
	 * 空白，直到用户切换视图或删/改会话重新触发一次加载。
	 *
	 * 三种失败面目，前两种完全无声：
	 *   1. daemon 回了 success，但宿主收到的 payload 行为空（请求 id 认领错位，
	 *      chunks 为空被解析成 0 条会话）；
	 *   2. daemon 从未发回终态（daemon 错误分支的终态受 requestContext 守卫，
	 *      上下文丢失时整条被吞），请求永久悬挂——两侧都没有逐请求超时；
	 *   3. 明确的 onError。
	 * 所以「空结果 / 超时 / 报错」一律重试，最终仍失败就明确报错 + 落日志，不再
	 * 静默推一个空列表。空列表本身是合法状态（新工作区/无会话），它只记 warn。
	 */
	private handleLoadHistoryData(): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.failLoadHistory('No daemon connection');
			return;
		}
		// 每次加载都是一个新序列：history.delete / history.rename 触发的重复加载会顶掉旧序列，
		// 防止过期结果（或过期重试）覆盖新结果。
		const seq = ++this.historyLoadSeq;
		this.requestSessions(daemon, this.context.resolveEffectiveWorkingDirectory() ?? undefined, 1, seq);
	}

	private failLoadHistory(error: string): void {
		logError(`history.refresh failed: ${error}`, undefined, 'HistoryHandler');
		this.callJavaScript(
			'setHistoryData',
			JSON.stringify({ success: false, error: `Failed to list sessions: ${error}`, sessions: [], total: 0, favorites: {} }),
		);
	}

	/** 单次 listSessions 尝试：软超时 / 空结果 / 报错都交给下一次尝试。 */
	private requestSessions(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		directory: string | undefined,
		attempt: number,
		seq: number,
	): void {
		if (seq !== this.historyLoadSeq) {
			return;
		}
		const chunks: string[] = [];
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		/** 结束本次尝试：failure 为 null 表示成功（成功路径直接推送，见下方 onComplete）。 */
		const finish = (failure: { message: string; empty?: boolean } | null): void => {
			if (settled || seq !== this.historyLoadSeq) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			if (failure === null) {
				return;
			}
			if (attempt < HISTORY_MAX_ATTEMPTS) {
				logWarn(`history.refresh attempt ${attempt} ${failure.message} — retrying`, 'HistoryHandler');
				timer = setTimeout(() => this.requestSessions(daemon, directory, attempt + 1, seq), HISTORY_RETRY_DELAY_MS);
				return;
			}
			if (failure.empty) {
				// 重试后仍是空：日志里必须能和「回包丢失」区分开；同时给前端一个
				// 终态，否则列表永远停在 loading 转圈。
				logWarn(`history.refresh returned an empty session list after ${attempt} attempts`, 'HistoryHandler');
				this.callJavaScript(
					'setHistoryData',
					JSON.stringify({ success: true, sessions: [], total: 0, favorites: {} }),
				);
				return;
			}
			this.failLoadHistory(`after ${attempt} attempts: ${failure.message}`);
		};

		// 悬挂兜底：没有终态时由下一次尝试顶掉这次请求。
		timer = setTimeout(
			() => finish({ message: `timed out after ${HISTORY_ATTEMPT_TIMEOUT_MS}ms` }),
			HISTORY_ATTEMPT_TIMEOUT_MS,
		);

		daemon.request('opencode.listSessions', { directory }, {
			onLine: (line) => chunks.push(line),
			onError: (err) => {
				finish({ message: typeof err === 'string' && err.trim() !== '' ? err : 'Failed to list sessions' });
			},
			onComplete: (success) => {
				if (settled) {
					return;
				}
				if (!success) {
					finish({ message: 'daemon reported failure' });
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
				if (rawSessions.length === 0) {
					finish({ message: 'returned an empty session list', empty: true });
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
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

		// 会话级模型/模式/推理力度的恢复不再依赖 webview 传入的行内值（历史
		// 快照从不更新，恢复旧值会把用户刚切换的选择覆盖掉——模型回退 bug）。
		// 跨会话加载时由 fetchAndRestoreMessages 从 daemon `session.get` 读
		// opencode 权威状态后推送恢复。

		const sessionManager = this.context.getSessionManager();
		const daemon = this.context.getDaemon();

		if (sessionManager) {
			const activeSession = sessionManager.getActiveSession();
			if (activeSession.state.getSessionId() === sessionId) {
				// 同会话软刷新
				if (!daemon || activeSession.state.isBusy()) {
					this.completeSessionLoad(sessionId);
					return;
				}
				this.callJavaScript('setSessionId', sessionId);
				void this.fetchAndRestoreMessages(daemon, activeSession, sessionId, false);
				return;
			}

			const session = sessionManager.switchToSession(sessionId);
			const summary = this.getSessions().find((s) => s.sessionId === sessionId);
			if (summary) {
				this.callJavaScript('updateSessionTitle', sessionId, summary.title);
			}

			if (!daemon) {
				this.finishSessionLoad(session, sessionId);
				return;
			}

			void this.fetchAndRestoreMessages(daemon, session, sessionId, true);
			return;
		}

		const session = this.context.getSession();
		if (!session) {
			return;
		}

		if (session.state.getSessionId() === sessionId) {
			if (!daemon || session.state.isBusy()) {
				this.completeSessionLoad(sessionId);
				return;
			}
			this.callJavaScript('setSessionId', sessionId);
			void this.fetchAndRestoreMessages(daemon, session, sessionId, false);
			return;
		}

		if (!daemon) {
			this.finishSessionLoad(session, sessionId);
			return;
		}

		session.resetSession();
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
		// A persisted transcript only carries the launch acknowledgement. Reconcile
		// once per load so a session reopened after the child finished does not
		// show a permanent spinner. Fire-and-forget: it never changes the load
		// result and forwards terminal states through the same callback chain as
		// the live `[SUBAGENT_STATUS]` event.
		void this.reconcileSubagentStates(daemon, session, sessionId);
		this.completeSessionLoad(sessionId);
	}

	private requestMessages(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
	): Promise<void> {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		// Daemon cold-start may return empty messages on the very first listMessages
		// call after startup (serve not ready, or the session transcript not yet
		// lazily loaded). Retry with a short delay when the response is successful
		// but contains zero messages.
		//
		// 方案 C：**失败**同样要重试。此前只有 `success && 空` 才重试，
		// `onError` / `onComplete(false)` 直接放弃 —— 冷启动 serve 未就绪时
		// 用户会拿到一个空白对话，且没有任何错误提示（错误被静默吞掉）。
		// 另外 daemon 的失败响应会先 onError 再 onComplete(false)，
		// 所以重试决策必须放在一个带 settled 闸门的统一出口里，否则会重复重试。
		const MAX_ATTEMPTS = 4;
		const RETRY_DELAY_MS = 600;

		const attempt = (attemptIndex: number): Promise<void> => {
			const collector = new ListMessagesCollector();
			return new Promise<void>((resolve) => {
				let settled = false;
				/** 本轮（或本轮之前）最近一次真实失败原因；成功应答会把它清掉。 */
				let failureReason: string | null = null;

				const finish = (reason: string | null): void => {
					if (settled) {
						return;
					}
					settled = true;
					if (reason) {
						// 让失败可见：此前静默只表现为「这个会话没有消息」。
						console.error(`[HistoryHandler] Failed to load messages for session ${sessionId}: ${reason}`);
						this.callJavaScript('updateStatus', `Failed to load session messages: ${reason}`);
					}
					// 恢复会话后同步 revert（redo）状态，供前端渲染撤销占位条 / 恢复按钮
					const revertState = session.state.getRevertState();
					this.callJavaScript(
						'onRevertStateUpdate',
						JSON.stringify({
							hasRevert: !!revertState,
							messageId: revertState?.messageID || null,
							sessionId,
						}),
					);
					resolve();
				};

				const retryLater = (): void => {
					if (settled) {
						return;
					}
					if (attemptIndex + 1 >= MAX_ATTEMPTS) {
						finish(failureReason);
						return;
					}
					settled = true;
					setTimeout(() => {
						void attempt(attemptIndex + 1).then(resolve);
					}, RETRY_DELAY_MS);
				};

				const ok = daemon.request(
					'opencode.listMessages',
					{
						sessionId,
						directory,
						// 显式要满一页：服务端默认页只有 50 条，长会话会被截断。
						limit: HISTORY_PAGE_MESSAGE_LIMIT,
					},
					{
					onLine: (line) => collector.onLine(line),
					onError: (error) => {
						failureReason = typeof error === 'string' ? error : 'listMessages failed';
						retryLater();
					},
					onComplete: (success) => {
						if (success) {
							collector.reconcileFallback();
							const messages = convertSdkMessages(collector.getEntries());
							if (messages.length > 0) {
								session.restoreMessages(messages);
								// 这一页就是该 tab 的历史窗口：游标、已加载条数/轮数
								// 必须一起落盘，否则「还有更早」既算不出来也翻不回去。
								session.historyWindow.applyFirstPage({
									sessionId,
									loadedCount: messages.length,
									loadedTurns: countUserTurns(messages),
									cursor: collector.getNextCursor(),
									// 满页判据在 daemon 侧用 rawCount 算好：条目数在这里
									// 已被过滤（idle/synthetic 等），不能拿来跟页大小比。
									hasEarlier: collector.getHasEarlier(),
									pageSize: HISTORY_PAGE_MESSAGE_LIMIT,
								});
								session.publishHistoryWindow();
								// 精确的「共 N 轮」需要按 user 类型再翻一次页；它与恢复
								// 无关，晚到也不会改变转录，所以不阻塞加载完成。
								this.requestUserTurnTotal(daemon, session, sessionId);
								if (!settled) {
									settled = true;
									resolve();
								}
								return;
							}
							// 成功但为空：可能是会话 transcript 尚未惰性加载完成。
							// 服务端确实给了应答，之前某轮的失败已被这次成功取代，
							// 所以清掉 failureReason —— 否则真·空会话会被误报成加载失败。
							failureReason = null;
						}
						retryLater();
					},
					},
				);
				if (!ok) {
					// 请求根本没排上队（daemon 未运行等）：同样走重试，而不是无声放弃
					failureReason = failureReason ?? 'daemon request was not accepted';
					retryLater();
				}
			});
		};

		return attempt(0);
	}

	/**
	 * 统计整个会话的用户回合数，供「还有 N 轮」这类文案使用。
	 *
	 * <p>用 `type=user` 过滤翻页，而不是拉全量：一个 1000+ 条消息的会话只有
	 * 十几个 user 记录。注意服务端的坑：过滤页即使已经到底，`cursor.next`
	 * 仍可能非空，所以**终止条件是某页返回 0 条**，不是游标为空。</p>
	 *
	 * <p>fire-and-forget：结果只影响文案，晚到就晚到；窗口 generation 变了
	 * （重新加载 / 换绑）则丢弃，不把旧会话的轮数写到新窗口上。</p>
	 */
	private requestUserTurnTotal(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
	): void {
		const historyWindow = session.historyWindow;
		const generation = historyWindow.getGeneration();
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		let total = 0;

		const finish = (): void => {
			if (!historyWindow.isCurrent(generation)) {
				return;
			}
			if (session.state.getSessionId() !== sessionId) {
				return;
			}
			historyWindow.setTotalTurns(total);
			session.publishHistoryWindow();
		};

		const requestPage = (cursor: string | null, pageIndex: number): void => {
			if (pageIndex >= HISTORY_USER_TURN_PAGE_LIMIT) {
				finish();
				return;
			}
			const collector = new ListMessagesCollector();
			let settled = false;
			const settle = (): void => {
				if (settled) {
					return;
				}
				settled = true;
			};
			const ok = daemon.request(
				'opencode.listMessages',
				{
					sessionId,
					directory,
					limit: HISTORY_PAGE_MESSAGE_LIMIT,
					type: 'user',
					cursor: cursor ?? undefined,
				},
				{
					onLine: (line) => collector.onLine(line),
					onError: () => {
						settle();
						finish();
					},
					onComplete: (success) => {
						if (settled) {
							return;
						}
						settle();
						if (!success) {
							finish();
							return;
						}
						collector.reconcileFallback();
						const entries = collector.getEntries();
						if (entries.length === 0) {
							// 过滤页的终点：不是「游标为空」，而是「这一页是空的」。
							finish();
							return;
						}
						total += entries.length;
						const nextCursor = collector.getNextCursor();
						if (!nextCursor) {
							finish();
							return;
						}
						requestPage(nextCursor, pageIndex + 1);
					},
				},
			);
			if (!ok) {
				settle();
				finish();
			}
		};

		requestPage(null, 0);
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
			this.completeSessionLoad(sessionId);
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

	/**
	 * 询问 core 本会话每个后台子代理的权威状态，把已终态的条目补发成与实时
	 * 事件相同的 `subagent.status`。
	 *
	 * <p>这是一个有界的一次性请求，不轮询；core 已经归一化 v1 `task` / v2
	 * `subagent` 的差异，因此这里没有任何引擎分支。</p>
	 */
	private reconcileSubagentStates(
		daemon: NonNullable<ReturnType<HandlerContext['getDaemon']>>,
		session: OpenCodeSession,
		sessionId: string,
	): void {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		const ok = daemon.request('opencode.getSessionSubagents', { sessionId, directory, limit: 20 }, {
			onLine: (line) => chunks.push(line),
			onError: () => {
				// A transient bridge error must not turn a still-running subagent
				// into a false terminal state; the live event remains authoritative.
			},
			onComplete: (success) => {
				if (!success) {
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const list = payload?.subagents;
				if (!Array.isArray(list)) {
					return;
				}
				for (const item of list) {
					if (!item || typeof item !== 'object') {
						continue;
					}
					const entry = item as Record<string, unknown>;
					if (entry.terminal !== true) {
						continue;
					}
					const toolUseId = typeof entry.toolUseId === 'string' ? entry.toolUseId.trim() : '';
					const rawStatus = typeof entry.status === 'string' ? entry.status.trim() : '';
					if (!toolUseId || !rawStatus) {
						continue;
					}
					session.notifySubagentStatus({
						parentSessionId: sessionId,
						toolUseId,
						childSessionId: typeof entry.childSessionId === 'string' ? entry.childSessionId : null,
						// Core's batch vocabulary is completed|error|running; the event
						// contract is completed|failed|stopped.
						status: rawStatus === 'error' ? 'failed' : rawStatus,
						...(typeof entry.description === 'string' && entry.description
							? { description: entry.description }
							: {}),
						...(typeof entry.summary === 'string' && entry.summary
							? { summary: entry.summary }
							: {}),
					});
				}
			},
		});
		if (!ok) {
			// The daemon is not accepting requests; the parent tool result remains
			// the replay/bootstrap source and the live event path is unaffected.
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
		this.completeSessionLoad(sessionId);
	}

	/**
	 * Finish one history load.
	 *
	 * <p>Two things must happen together: the tab leaves
	 * {@code LOADING_HISTORY} (otherwise its message queue never drains) and the
	 * webview releases its session-transition guard. Idea does the same in its
	 * {@code markHistoryLoaded}.</p>
	 */
	private completeSessionLoad(sessionId: string): void {
		this.context.markHistoryLoaded(sessionId);
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
	 * v2 命令的会话 id：`{"sessionId":"ses_x"}`。
	 *
	 * <p>宿主在 `HostCommand.parse` 里把信封身份合进了 payload，所以删除/收藏
	 * 拿到的永远是 JSON 对象，不再是 idea 早期 `delete_session:ses-x` 的裸字符串。
	 * 裸字符串只作防御性兼容。</p>
	 */
	private readSessionId(content: string): string {
		const raw = (content ?? '').trim();
		if (!raw) {
			return '';
		}
		if (raw.startsWith('{')) {
			try {
				const json = JSON.parse(raw) as Record<string, unknown>;
				return typeof json.sessionId === 'string' ? json.sessionId.trim() : '';
			} catch {
				return '';
			}
		}
		return raw;
	}

	/** 被删会话若仍挂在某个 tab 上并且在跑，先中断（idea `quiesceActiveSessionForDeletion`）。 */
	private quiesceSession(sessionId: string): void {
		const owner = this.context.getSessionBySessionId(sessionId);
		if (owner && owner.state.isBusy()) {
			owner.interrupt();
		}
	}

	/** 删除历史会话（v2 `history.delete`，payload `{ sessionId }`）。 */
	private handleDeleteSession(content: string): void {
		const sessionId = this.readSessionId(content);
		if (!SESSION_ID_PATTERN.test(sessionId)) {
			logWarn(`history.delete rejected: invalid sessionId`, 'HistoryHandler');
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.failLoadHistory('No daemon connection');
			return;
		}
		this.quiesceSession(sessionId);
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		void daemon.request('opencode.deleteSession', { sessionId, directory }, {
			onLine: () => {},
			onError: (err) => {
				logWarn(`opencode.deleteSession failed: ${String(err)}`, 'HistoryHandler');
			},
			// 成败都重拉列表：成功拿到删掉之后的权威列表，失败把 webview 的
			// 乐观删除撤回——不另发错误提示，列表本身就是真相。
			onComplete: (success) => {
				if (success) {
					this.forgetSessionSummary(sessionId);
				}
				this.handleLoadHistoryData();
			},
		});
	}

	/** 批量删除（v2 `history.deleteMany`，payload `{ sessionIds }`）。 */
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
		const idSet = new Set(ids.map((id) => id.trim()).filter((id) => SESSION_ID_PATTERN.test(id)));
		if (idSet.size === 0) {
			logWarn('history.deleteMany rejected: no valid sessionIds', 'HistoryHandler');
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.failLoadHistory('No daemon connection');
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const idList = Array.from(idSet);
		const promises = idList.map((sessionId) => {
			this.quiesceSession(sessionId);
			return new Promise<boolean>((resolve) => {
				void daemon.request('opencode.deleteSession', { sessionId, directory }, {
					onLine: () => {},
					onError: (err) => {
						logWarn(`opencode.deleteSession failed for ${sessionId}: ${String(err)}`, 'HistoryHandler');
					},
					onComplete: (success) => resolve(success),
				});
			});
		});
		void Promise.all(promises).then((results) => {
			results.forEach((success, index) => {
				if (success) {
					this.forgetSessionSummary(idList[index]);
				}
			});
			// 与单条删除同一规则：成败都重拉，列表即真相。
			this.handleLoadHistoryData();
		});
	}

	/** 收藏（v2 `history.favorite`，payload `{ sessionId }`）。 */
	private handleToggleFavorite(content: string): void {
		const sessionId = this.readSessionId(content);
		if (!SESSION_ID_PATTERN.test(sessionId)) {
			logWarn(`history.favorite rejected: invalid sessionId`, 'HistoryHandler');
			return;
		}
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		void daemon.request('opencode.toggleFavorite', { sessionId, directory }, {
			onLine: () => {},
			onError: (err) => {
				logWarn(`opencode.toggleFavorite failed: ${String(err)}`, 'HistoryHandler');
			},
			// 收藏状态存在 session.metadata 里：成败都重拉一次，成功拿到服务端
			// 权威值，失败把 webview 的乐观切换撤回。
			onComplete: () => {
				this.handleLoadHistoryData();
			},
		});
	}

	/**
	 * 重命名（v2 `history.rename`，payload `{ sessionId, title }`）。
	 *
	 * <p>历史行是**会话级**操作：它按会话 id 定址，不要求该会话正开在某个 tab
	 * 里（tab 栏改名走 tab 级的 `session.rename`）。写成功后把标题按会话所属
	 * tab 发回 `tab.title.changed`，宿主记录与其他视图一起更新。</p>
	 */
	private handleUpdateTitle(content: string): void {
		let sessionId = '';
		let title = '';
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			sessionId = typeof json?.sessionId === 'string' ? json.sessionId.trim() : '';
			// 与 idea `HistoryMetadataService` 同序：`customTitle` 优先，`title` 兜底。
			title = typeof json?.customTitle === 'string' ? json.customTitle : (typeof json?.title === 'string' ? json.title : '');
		} catch {
			// 忽略解析失败
			return;
		}
		if (!SESSION_ID_PATTERN.test(sessionId) || !title.trim()) {
			logWarn('history.rename rejected: incomplete payload', 'HistoryHandler');
			return;
		}
		// 标题是单行的：换行折成空格，和宿主 `applyTitleEvent` 的清洗规则一致。
		const cleanTitle = title.replace(/[\r\n]+/g, ' ').trim();
		const daemon = this.context.getDaemon();
		if (!daemon) {
			return;
		}
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		void daemon.request('opencode.updateSessionTitle', { sessionId, title: cleanTitle, directory }, {
			onLine: () => {},
			onError: (err) => {
				logWarn(`opencode.updateSessionTitle failed: ${String(err)}`, 'HistoryHandler');
			},
			onComplete: (success) => {
				if (success) {
					// 标题属于会话：发到它所属的 tab，走宿主唯一标题发布口。
					// 事件本身就是 webview 的 `updateSessionTitle`（见 EventCatalog），
					// 所以 `legacy: false`——不再额外按位置调一次 `window.<fn>`。
					this.context.publishTabEvent(
						'tab.title.changed',
						this.context.getTabIdForSession(sessionId),
						{ title: cleanTitle, source: 'user' },
						{ sessionId, legacy: false },
					);
				}
				// 成功：历史行换成服务端标题；失败：把 webview 的乐观改名撤回。
				this.handleLoadHistoryData();
			},
		});
	}

	/**
	 * Load a subagent's transcript via the OpenCode daemon.
	 *
	 * OpenCode persists each subagent sidechain as a real child session (a
	 * session row whose `parentID` points at the parent), and core deliberately
	 * hides those children from the history list. The webview still hands this
	 * handler the *parent* session id for a subagent block: the invocation and
	 * result are mirrored inside the parent transcript as a `tool_use` block
	 * (id === toolUseId, for the task/subagent tool) plus its `tool_result`. So
	 * we fetch the parent session's messages from the daemon, then extract the
	 * subagent's portion by toolUseId and push it to the webview.
	 *
	 * On success the response is `completed: true` (stopping the UI poll); while
	 * the subagent is still running and its tool_result has not been written yet
	 * we return `status: 'running'` so the webview keeps polling. A daemon error
	 * surfaces a single, truthful failure (never the old stub's misleading
	 * "not available from OpenCode daemon" message, which lied — the plugin had
	 * never actually contacted the daemon).
	 */
	handleLoadSubagentSession(content: string): void {
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
		const collector = new ListMessagesCollector();
		let finished = false;
		const finish = (payload: Record<string, unknown>): void => {
			if (finished) { return; }
			finished = true;
			send(payload);
		};

		daemon.request('opencode.listMessages', { sessionId, directory, limit: HISTORY_PAGE_MESSAGE_LIMIT }, {
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
