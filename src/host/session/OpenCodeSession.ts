/**
 * OpenCodeSession — TS 版会话编排，对应 cc-gui `ClaudeSession` + `SessionSendService`。
 * 只保留 opencode：send 走 daemon 的 `opencode.send`（常驻 serve + SDK），
 * 输出 marker 行经 MarkerParser → MessageHandler 状态机 → SessionCallbackAdapter
 * → window.<fn> 推送 webview。
 */
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { HandlerContext } from '../router/HandlerContext';
import { SessionState, createMessage, normalizePermissionMode } from './SessionState';
import { CallbackHandler } from './CallbackHandler';
import { MessageHandler } from './MessageHandler';
import { MarkerStreamContext, processOutputLine } from './MarkerParser';
import { SessionStreamRouter } from './SessionStreamRouter';
import { SessionCallbackAdapter } from './SessionCallbackAdapter';
import { MessageType } from './types';
import { convertMessagesToJson } from '../util/MessageJsonConverter';
import { convertSdkMessages } from './SdkMessageConverter';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { extractContextTokens, findLastUsageFromMessages } from '../util/TokenUsageUtils';
import { getModelContextLimit } from '../util/ModelContextLimits';
import { logDiagnostic } from '../util/DiagnosticLogger';
import type { ChatMessage, PermissionRequest } from './types';

/** webview send_message / send_message_with_attachments 的 payload。 */
export interface SendMessagePayload {
	text: string;
	sessionId?: string;
	tabId?: string;
	attachments?: Array<{ fileName?: string; mediaType?: string; data?: string }>;
	fileTags?: Array<{ displayPath?: string; absolutePath?: string }> | null;
	permissionMode?: string;
	reasoningEffort?: string;
	/** 该 tab 的文件上下文开关（前端 per-tab 状态，优先于全局设置）。 */
	autoOpenFileEnabled?: boolean;
}

export interface OpenCodeSessionOptions {
	context: HandlerContext;
	daemon: OpenCodeDaemonBridge;
	initialSessionId?: string | null;
	/** 会话结束时（如新会话 / 销毁）额外清理钩子。 */
	onSessionEnded?: () => void;
	/** 真实会话 ID 变更时通知（由临时 ID 换成服务端真实 ID）。 */
	onSessionIdChanged?: (oldSessionId: string | null, newSessionId: string) => void;
	/** 权限/提问请求处理（Phase 4 接 webview 弹层）。 */
	permissionHandler?: (request: PermissionRequest) => void;
	/** 服务端已答复/取消未决 prompt（同步关闭 webview 卡片）。 */
	permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	/** 每个流式 turn 结束时回调（用于登记会话历史 + 任务完成/警示通知）。 */
	onTurnCompleted?: (info: TurnCompletedInfo) => void;
	/** 发送时解析当前编辑器上下文（'@path#L1-L2'），cc-gui EditorContextCollector 等价物。 */
	editorSelectionResolver?: () => string | null;
}

export type TurnCompletedStatus = 'completed' | 'aborted' | 'error';

export interface TurnCompletedInfo {
	sessionId: string | null;
	title: string;
	messageCount: number;
	/** completed=正常结束；aborted=用户手动中断；error=轮次执行出错。 */
	status: TurnCompletedStatus;
}

export class OpenCodeSession {
	readonly state = new SessionState();
	private readonly context: HandlerContext;
	private readonly daemon: OpenCodeDaemonBridge;
	private readonly callbackHandler: CallbackHandler;
	private readonly streamRouter: SessionStreamRouter;
	private readonly messageHandler: MessageHandler;
	private readonly adapter: SessionCallbackAdapter;
	private readonly onSessionEnded?: () => void;
	private readonly permissionHandler?: (request: PermissionRequest) => void;
	private readonly permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	private readonly onTurnCompleted?: (info: TurnCompletedInfo) => void;
	private readonly editorSelectionResolver?: () => string | null;

	// 单轮流式状态（由 SessionStreamRouter 维护）
	private get streamCtx(): MarkerStreamContext {
		return this.streamRouter.getStreamContext();
	}
	/** 当前正在进行的请求 ID，用于精准 abort */
	private activeRequestId: string | null = null;

	constructor(options: OpenCodeSessionOptions) {
		this.context = options.context;
		this.daemon = options.daemon;
		this.onSessionEnded = options.onSessionEnded;
		this.permissionHandler = options.permissionHandler;
		this.permissionClosedHandler = options.permissionClosedHandler;
		this.onTurnCompleted = options.onTurnCompleted;
		this.editorSelectionResolver = options.editorSelectionResolver;

		this.callbackHandler = new CallbackHandler();
		this.streamRouter = new SessionStreamRouter(this.state, this.callbackHandler);
		this.messageHandler = this.streamRouter.getMessageHandler();
		this.adapter = new SessionCallbackAdapter({
			jsTarget: {
				callJavaScript: (fn, ...args) => this.context.callJavaScript(fn, ...args),
			},
			model: () => this.state.getModel(),
			windowBaseIndex: () => this.state.getWindowBaseIndex(),
			streamEndCallback: () => this.onTurnEnded(),
			permissionHandler: (request) => this.permissionHandler?.(request),
			permissionClosedHandler: (kind, content) => this.permissionClosedHandler?.(kind, content),
			onSessionIdReceived: (newId) => {
				const oldId = this.state.getSessionId();
				this.state.setSessionId(newId);
				if (oldId !== newId) {
					if (oldId && typeof this.daemon.unregisterSessionSink === 'function') {
						this.daemon.unregisterSessionSink(oldId);
					}
					this.bindSessionSink(newId);
					options.onSessionIdChanged?.(oldId, newId);
				}
			},
		});
		this.callbackHandler.setCallback(this.adapter);

		if (options.initialSessionId) {
			this.state.setSessionId(options.initialSessionId);
			this.adapter.setSessionId(options.initialSessionId);
			this.bindSessionSink(options.initialSessionId);
		}
	}

	bindSessionSink(sessionId: string | null): void {
		if (sessionId && sessionId.trim() !== '') {
			if (typeof this.daemon.registerSessionSink === 'function') {
				this.daemon.registerSessionSink(sessionId, this.streamRouter);
			}
		}
	}

	getStreamRouter(): SessionStreamRouter {
		return this.streamRouter;
	}

	hasActiveRequest(): boolean {
		return this.activeRequestId !== null;
	}

	getActiveRequestId(): string | null {
		return this.activeRequestId;
	}

	getAdapter(): SessionCallbackAdapter {
		return this.adapter;
	}

	private callView(functionName: string, ...args: string[]): void {
		this.context.callJavaScript(functionName, ...args);
	}


	/**
	 * 发送一条消息。non-blocking；结果经流管道异步回传 webview。
	 */
	async send(payload: SendMessagePayload): Promise<void> {
		const text = payload.text ?? '';
		const cwd = this.state.getCwd() ?? this.context.resolveEffectiveWorkingDirectory() ?? undefined;

		// opencode 原生斜杠命令：'/name args...' → 走 /session/{id}/command。
		// 与 TUI 一致，任何前导 '/' 文本都视为命令（未知命令由服务端报错）。
		const slashCommand = parseSlashCommand(text);

		const projectPath = this.context.getSettingsService().getPrimaryWorkspaceRoot();
		// 文件上下文是否注入由「当前 tab」决定（前端随消息发送）；
		// 只有旧版前端不带该字段时才回退到全局设置。
		const autoOpenFileOn = typeof payload.autoOpenFileEnabled === 'boolean'
			? payload.autoOpenFileEnabled
			: (!projectPath || this.context.getSettingsService().getAutoOpenFileEnabled(projectPath));
		const selInfo = this.editorSelectionResolver?.() ?? null;

		let messageToSend = text;
		if (!slashCommand) {
			const contextAppend = buildContextAppend(payload, autoOpenFileOn, selInfo);
			messageToSend = (text ? text : '') + contextAppend;
		}

		// 更新会话配置（permissionMode / reasoningEffort 来自 payload）
		if (payload.permissionMode) {
			this.state.setPermissionMode(payload.permissionMode);
		}
		if (payload.reasoningEffort != null) {
			this.state.setReasoningEffort(payload.reasoningEffort);
		}

		const attachments = buildAttachments(payload);

		// cc-gui `SessionSendService.updateSessionStateForSend`：先把用户消息入状态
		// 并立即推给前端（乐观气泡由内容+时间窗口匹配归位），再建立会话摘要。
		//
		// 入状态前先按 revert 边界裁剪：pending revert 会在本次 prompt 开始时由服务端
		// 执行 cleanup（从边界消息起全部删除），本地先裁掉同样的范围，随后推给前端的
		// 快照才不会把已作废的那一轮带回去 —— 否则它们会先「复活」闪现，直到
		// message.removed 到达才消失。
		if (this.state.trimMessagesFromRevertBoundary()) {
			logDiagnostic('[Revert] Trimmed session state from the revert boundary before send');
		}
		const userMessage = buildUserMessage(payload.text, payload.attachments);
		this.state.addMessage(userMessage);
		this.state.setError(null);
		this.state.setBusy(true);
		this.state.setLoading(true);
		this.state.updateLastModifiedTime();
		this.adapter.onMessageUpdate(this.state.getMessages());
		this.adapter.onStateChange(true, true, null);
		if (this.state.getSummary() == null && userMessage.content && userMessage.content.trim() !== '') {
			const summary = truncateSummary(userMessage.content);
			this.state.setSummary(summary);
			this.adapter.onSummaryReceived(summary);
		}

		const ctx = this.streamRouter.getStreamContext();
		ctx.assistantContent = '';
		ctx.hadSendError = false;
		ctx.lastNodeError = null;
		ctx.wasAborted = false;

		const params: Record<string, unknown> = {
			sessionId: this.state.getSessionId() ?? undefined,
			...(slashCommand
				? { command: slashCommand.command, commandArguments: slashCommand.arguments }
				: { message: messageToSend }),
			model: this.state.getModel() ?? undefined,
			mode: normalizePermissionMode(this.state.getPermissionMode()) ?? undefined,
			reasoningEffort: this.state.getReasoningEffort() ?? undefined,
			cwd: cwd ?? undefined,
			attachments: attachments.length > 0 ? attachments : undefined,
		};

		await this.daemon.request('opencode.send', params, {
			onStart: (requestId) => {
				this.activeRequestId = requestId;
			},
			onLine: (line) => this.processLine(line),
			onStderr: (stderr) => {
				logDiagnostic(stderr, 'Daemon');
			},
			onError: (error) => {
				this.activeRequestId = null;
				this.messageHandler.onError(error);
			},
			onComplete: (success) => {
				this.activeRequestId = null;
				// wasAborted：用户主动中断不是错误，与 MarkerParser 对
				// [SEND_ERROR] 的抑制保持同一语义。
				if (!success && !this.streamCtx.hadSendError && !this.streamCtx.wasAborted) {
					this.messageHandler.onError(this.streamCtx.lastNodeError ?? '发送失败');
				}
				this.messageHandler.onComplete({
					messages: this.state.getMessages(),
					success,
					error: this.streamCtx.lastNodeError,
				});
			},
			onAbort: () => {
				this.activeRequestId = null;
				this.streamRouter.getStreamContext().wasAborted = true;
				this.messageHandler.onComplete({ messages: this.state.getMessages(), success: false });
			},
		});
	}

	/**
	 * opencode 原生 `!` 语义：把 shell 命令透传给 opencode 服务端执行
	 * （POST /session/{id}/shell）。服务端记录 bash 工具结果并触发 AI 回复，
	 * 流式管线与 send() 完全一致。
	 */
	async sendShell(command: string, cwdOverride?: string | null): Promise<void> {
		const trimmed = (command ?? '').trim();
		if (!trimmed) {
			return;
		}
		const cwd = cwdOverride ?? this.state.getCwd() ?? this.context.resolveEffectiveWorkingDirectory() ?? undefined;

		this.state.setError(null);
		this.state.setBusy(true);
		this.state.setLoading(true);
		this.state.updateLastModifiedTime();

		// 乐观用户气泡：显示 `!command`，让命令在会话记录中可见。
		const userMessage = createMessage(
			MessageType.USER,
			`!${trimmed}`,
			{ type: 'user', message: { content: [{ type: 'text', text: `!${trimmed}` }] } },
		);
		this.state.addMessage(userMessage);
		this.adapter.onMessageUpdate(this.state.getMessages());
		this.adapter.onStateChange(true, true, null);

		const shellCtx = this.streamRouter.getStreamContext();
		shellCtx.assistantContent = '';
		shellCtx.hadSendError = false;
		shellCtx.lastNodeError = null;
		shellCtx.wasAborted = false;

		const params: Record<string, unknown> = {
			sessionId: this.state.getSessionId() ?? undefined,
			command: trimmed,
			model: this.state.getModel() ?? undefined,
			mode: normalizePermissionMode(this.state.getPermissionMode()) ?? undefined,
			cwd: cwd ?? undefined,
		};

		await this.daemon.request('opencode.shell', params, {
			onStart: (requestId) => {
				this.activeRequestId = requestId;
			},
			onLine: (line) => this.processLine(line),
			onStderr: (stderr) => {
				logDiagnostic(stderr, 'Daemon');
			},
			onError: (error) => {
				this.activeRequestId = null;
				this.messageHandler.onError(error);
			},
			onComplete: (success) => {
				this.activeRequestId = null;
				if (!success && !this.streamCtx.hadSendError && !this.streamCtx.wasAborted) {
					this.messageHandler.onError(this.streamCtx.lastNodeError ?? 'Shell 执行失败');
				}
				this.messageHandler.onComplete({
					messages: this.state.getMessages(),
					success,
					error: this.streamCtx.lastNodeError,
				});
			},
			onAbort: () => {
				this.activeRequestId = null;
				this.streamRouter.getStreamContext().wasAborted = true;
				this.messageHandler.onComplete({ messages: this.state.getMessages(), success: false });
			},
		});
	}

	private processLine(line: string): void {
		this.streamRouter.onLine(line);
	}

	/** 流式 turn 结束时的宿主侧回调（可在会话层面做延迟工作）。 */
	private onTurnEnded(): void {
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.updateLastModifiedTime();
		const status: TurnCompletedStatus = this.streamCtx.wasAborted
			? 'aborted'
			: this.streamCtx.hadSendError
				? 'error'
				: 'completed';
		this.onTurnCompleted?.({
			sessionId: this.state.getSessionId(),
			title: this.state.getSummary() ?? '',
			messageCount: this.state.getTotalCount(),
			status,
		});
	}

	interrupt(): void {
		this.state.setBusy(false);
		this.state.setLoading(false);
		// 用户主动中断：先收尾流式状态（含最终消息快照 + onStreamEnd），
		// 让 webview 在停止按钮生效时就把已生成的回复定住，而不是留在
		// isStreaming 占位气泡里等一条不会再来的正常 [STREAM_END]。
		// 快照包含本轮的用户消息（发送时已入 state）与中断前生成的
		// assistant 内容，webview 据此完成气泡收尾。
		this.messageHandler.interruptTurn(this.state.getMessages());
		// 标记中断并复用正常收尾路径：登记会话历史 + aborted 状态通知，
		// 与 daemon abort 之后回流的 onComplete(streamEndedThisTurn) 清理
		// 分支语义一致。
		this.streamCtx.wasAborted = true;
		this.onTurnEnded();
		const sessionId = this.state.getSessionId() ?? undefined;
		const requestId = this.activeRequestId ?? undefined;
		this.activeRequestId = null;
		this.daemon.sendAbort(sessionId, requestId);
	}

	/**
	 * 从服务端全量装入当前会话（idea `SessionMessageOrchestrator.loadFromServer`）。
	 *
	 * 与 `HistoryHandler.fetchAndRestoreMessages` 的区别：那里是「打开历史列表里的
	 * 某个会话」的交互流程（自带重试、回执、状态恢复），这里是**会话对象的自我
	 * 修复**，供切换 tab / 视图重新可见 / 水化前对账调用。
	 *
	 * 硬约束（照 idea）：
	 *  - 失败**必须 reject**，不能吞成「成功但为空」—— 否则调用方会留下
	 *    「sessionId 已绑定 + 消息为空」的幽灵会话，用户下一条消息就追加进旧对话；
	 *  - 成功但为空是合法结果（新会话），由调用方按 `messages.length` 自行判断。
	 */
	async loadFromServer(): Promise<void> {
		const sessionId = this.state.getSessionId();
		if (!sessionId) {
			return;
		}
		this.state.setLoading(true);
		this.adapter.onStateChange(this.state.isBusy(), true, this.state.getError());
		try {
			const messages = await this.fetchServerMessages(sessionId);
			this.state.setError(null);
			this.state.replaceMessages(messages);
			this.adapter.onMessageUpdate(this.state.getMessages());
			this.republishUsageFromHistory();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.state.setError(message);
			throw error instanceof Error ? error : new Error(message);
		} finally {
			this.state.setLoading(false);
			this.adapter.onStateChange(this.state.isBusy(), false, this.state.getError());
		}
	}

	/**
	 * 与服务端转录做**非破坏性**对账（idea `reconcileWithServer`）。
	 *
	 * 只在「空闲 + 服务端确实更多或末条不同」时替换本地快照；服务端返回空而本地
	 * 有消息时保持本地（冷启动 / serve 未就绪时最容易命中，替换会把正常对话清空）。
	 *
	 * @returns 是否用服务端快照替换了本地状态。
	 */
	async reconcileWithServer(): Promise<boolean> {
		const sessionId = this.state.getSessionId();
		if (!sessionId || this.state.isBusy()) {
			return false;
		}
		let serverMessages: ChatMessage[];
		try {
			serverMessages = await this.fetchServerMessages(sessionId);
		} catch (error) {
			logDiagnostic(`[Reconcile] failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		if (serverMessages.length === 0) {
			return false;
		}
		const localMessages = this.state.getMessages();
		let needsUpdate = serverMessages.length > localMessages.length;
		if (!needsUpdate && serverMessages.length === localMessages.length && localMessages.length > 0) {
			const latestServer = serverMessages[serverMessages.length - 1];
			const latestLocal = localMessages[localMessages.length - 1];
			needsUpdate = (latestServer.content ?? '') !== (latestLocal.content ?? '');
		}
		if (!needsUpdate) {
			return false;
		}
		// 拉取期间用户可能已经发起了新一轮：替换会把它抹掉。
		if (this.state.isBusy()) {
			logDiagnostic(`[Reconcile] session became busy during reconcile, discarding snapshot: ${sessionId}`);
			return false;
		}
		this.state.setError(null);
		this.state.replaceMessages(serverMessages);
		this.adapter.onMessageUpdate(this.state.getMessages());
		this.republishUsageFromHistory();
		return true;
	}

	/**
	 * 把宿主权威快照推给 webview（idea `hydrateSessionToWebview`）。
	 *
	 * 通道是 `callJavaScript(fn, ...args)` → `postMessage({ type, args })`，因此整包
	 * 作为**单参**下发即可；让前端按 `(sessionId, payload)` 双参解只会多一层歧义。
	 *
	 * `origin: true` 时只发给发起当前消息的那个视图——就绪握手期间其余视图
	 * 已经在展示同一份内容，无需重灌。
	 */
	hydrateSessionToWebview(options?: { origin?: boolean }): void {
		const sessionId = this.state.getSessionId();
		if (!sessionId || sessionId.trim() === '') {
			return;
		}
		try {
			const messages = this.state.getMessages();
			const packet: Record<string, unknown> = {
				sessionId,
				isStreaming: this.state.isBusy(),
				loading: this.state.isLoading(),
				messages,
			};
			const revertState = this.state.getRevertState();
			if (revertState) {
				packet.revertBoundaryId = revertState.messageID;
			}
			const payload = JSON.stringify(packet);
			if (options?.origin) {
				this.context.callJavaScriptToOrigin('onSessionHydrated', payload);
			} else {
				this.callView('onSessionHydrated', payload);
			}
		} catch (error) {
			logDiagnostic(`[hydrateSession] failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 通知视图「历史加载结束」。
	 *
	 * 必须带 `(sessionId, count)`：前端据此做快照对账，避免「先渲染半截、
	 * 快照再补齐」的闪烁，也避免把别的会话的回执当成自己的。此前宿主裸调用，
	 * 前端那段解析逻辑成了死代码（idea `SessionLifecycleManager.java:287`）。
	 */
	notifyHistoryLoadComplete(): void {
		const sessionId = this.state.getSessionId();
		if (!sessionId) {
			this.callView('historyLoadComplete');
			return;
		}
		this.callView('historyLoadComplete', sessionId, String(this.state.getMessages().length));
	}

	/** 重试用尽仍拿不到消息：明确告知并提示旧会话仍可从历史打开。 */
	notifyMessageLoadFailure(detail?: string): void {
		const suffix = detail ? `: ${detail}` : '';
		this.callView(
			'addErrorMessage',
			`Failed to load session messages${suffix}. Starting a new session; `
			+ 'the previous conversation is still available in History.',
		);
	}

	/** 通过 daemon `opencode.listMessages` 拉取服务端转录并转换为宿主消息。 */	private fetchServerMessages(sessionId: string): Promise<ChatMessage[]> {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		return new Promise<ChatMessage[]>((resolve, reject) => {
			const collector = new ListMessagesCollector();
			void this.daemon
				.request('opencode.listMessages', { sessionId, directory }, {
					onLine: (line) => collector.onLine(line),
					onError: (error) => {
						reject(new Error(typeof error === 'string' ? error : 'listMessages failed'));
					},
					onComplete: (success) => {
						if (!success) {
							reject(new Error('listMessages failed'));
							return;
						}
						try {
							collector.reconcileFallback();
							resolve(convertSdkMessages(collector.getEntries()) as ChatMessage[]);
						} catch (error) {
							reject(error instanceof Error ? error : new Error(String(error)));
						}
					},
				})
				.catch((error) => {
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
	}

	/**
	 * 新建 / 重置会话：忙碌的旧会话一律中断（abort），随后重置状态机为新对话分配独立上下文。
	 */
	resetSession(): void {
		const isBusy = this.state.isBusy() || this.activeRequestId != null;
		if (isBusy) {
			// 停止旧会话：发送 abort 信号，收尾 turn 并释放资源
			this.interrupt();
		}

		const seq = this.adapter.coalescer.resetStreamState();
		this.callView('clearMessages', String(seq));
		this.state.clearMessages();
		this.messageHandler.resetTurnState();
		this.state.setSessionId(null);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.setError(null);
		this.state.setRevertState(null);
		// 新会话无 redo 状态，同步前端隐藏 Redo 按钮
		this.callView('onRevertStateUpdate', JSON.stringify({ hasRevert: false }));
		this.onSessionEnded?.();
	}

	/** 从历史恢复：collector 已按 tail 窗口保留，直接采纳窗口与全量元数据。 */
	/** 从历史恢复：全量装入状态并推送 updateMessages。 */
	restoreMessages(messages: unknown[]): void {
		const seq = this.adapter.coalescer.resetStreamState();
		this.state.clearMessages();
		for (const m of messages) {
			this.state.addMessage(m as ChatMessage);
		}
		this.callView('clearMessages', String(seq));
		this.callView(
			'updateMessages',
			convertMessagesToJson(this.state.getMessages()),
			String(seq),
		);

		// 恢复历史 Token 统计
		this.republishUsageFromHistory();
	}

	/**
	 * 用当前解析出的额度重推一次用量快照。
	 *
	 * 会话恢复时模型目录可能还是冷的，会先推硬编码的 200k；目录热起来之后若不
	 * 重推，已经渲染的用量环会一直错到下一轮。没有历史用量则不推，UI 保持原样。
	 */
	republishUsageFromHistory(): void {
		const lastUsage = findLastUsageFromMessages(this.state.getMessages());
		if (!lastUsage) {
			return;
		}
		this.pushUsageSnapshot(lastUsage);
	}

	/**
	 * 切换模型后按新模型的上下文额度重算用量环。
	 *
	 * 分母是模型自身的属性，`set_model` 不重推的话，用量环会一直停在旧模型的
	 * 额度上（1M 的模型切过去仍显示 200k），直到下一轮 usage 事件才纠正。
	 * 没有历史用量时清空显示 —— 旧模型的额度不能当成新模型的分母
	 * （对应 cc-gui `pushUsageUpdateAfterModelChange`）。
	 */
	republishUsageAfterModelChange(): void {
		const lastUsage = findLastUsageFromMessages(this.state.getMessages());
		if (!lastUsage) {
			this.adapter.clearUsage();
			return;
		}
		this.pushUsageSnapshot(lastUsage);
	}

	/** 用当前 state.getModel() 解析出的额度推送用量快照。 */
	private pushUsageSnapshot(lastUsage: Record<string, unknown>): void {
		const usedTokens = extractContextTokens(lastUsage, this.state.getProvider());
		const maxTokens = getModelContextLimit(this.state.getModel());
		this.callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
	}

	dispose(): void {
		const sessionId = this.state.getSessionId();
		if (sessionId && typeof this.daemon.unregisterSessionSink === 'function') {
			this.daemon.unregisterSessionSink(sessionId);
		}
		this.adapter.dispose();
	}
}

/**
 * 构造宿主侧用户消息（cc-gui `SessionContextService.buildUserMessage`）：
 * content = 文本（空则用附件摘要），raw 携带 image 块 + text 块，供前端
 * 乐观气泡按内容匹配归位。
 */
function buildUserMessage(
	text: string,
	attachments?: SendMessagePayload['attachments'],
): ChatMessage {
	const displayText = text && text.trim() !== '' ? text : generateAttachmentSummary(attachments);
	const contentBlocks: Array<Record<string, unknown>> = [];
	if (Array.isArray(attachments)) {
		for (const att of attachments) {
			const isImage = typeof att?.mediaType === 'string' && att.mediaType.startsWith('image/');
			if (isImage) {
				contentBlocks.push({
					type: 'image',
					source: { type: 'base64', media_type: att.mediaType, data: att.data },
				});
			} else if (att?.fileName) {
				contentBlocks.push({
					type: 'attachment',
					fileName: att.fileName,
					mediaType: att.mediaType || '',
				});
			}
		}
	}
	contentBlocks.push({ type: 'text', text: displayText });
	return createMessage(MessageType.USER, displayText, {
		type: 'user',
		message: { content: contentBlocks },
	});
}

/** cc-gui `generateAttachmentSummary`：无文本时生成附件摘要作为用户消息内容。 */
function generateAttachmentSummary(attachments?: SendMessagePayload['attachments']): string {
	if (!Array.isArray(attachments)) {
		return '';
	}
	const names: string[] = [];
	let imageCount = 0;
	for (const att of attachments) {
		if (att?.fileName) {
			names.push(att.fileName);
		}
		if (typeof att?.mediaType === 'string' && att.mediaType.startsWith('image/')) {
			imageCount++;
		}
	}
	const parts: string[] = [];
	if (imageCount > 0) {
		parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
	}
	if (names.length > 0) {
		parts.push(names.join(', '));
	}
	return parts.length > 0 ? parts.join(': ') : '[Attachments]';
}

/** 解析前导斜杠命令：'/name args...' → {command, arguments}；非合法命令（如 URL/文件路径 /v2/...、普通语句）返回 null。 */
export function parseSlashCommand(text: string): { command: string; arguments: string } | null {
	const trimmed = text.trim();
	const m = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!m || !m[1]) {
		return null;
	}
	return { command: m[1], arguments: (m[2] ?? '').trim() };
}

/** cc-gui summary 截断（45 字符 + 省略号）。 */
function truncateSummary(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 45) {
		return trimmed;
	}
	return `${trimmed.slice(0, 45)}...`;
}

/** 把 webview 的 attachments 归一成 daemon `opencode.send` 的附件（fileTags 走 Referenced Files 提示词注入）。 */
function buildAttachments(payload: SendMessagePayload): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];

	if (Array.isArray(payload.attachments)) {
		for (const att of payload.attachments) {
			const isImage = typeof att.mediaType === 'string' && att.mediaType.startsWith('image/');
			result.push({
				type: isImage ? 'image' : 'file',
				name: att.fileName,
				fileName: att.fileName,
				mediaType: att.mediaType,
				data: att.data,
				...(isImage ? { imageData: att.data } : { content: att.data }),
			});
		}
	}

	return result;
}

/**
 * 组装上下文追加 markdown（## Referenced Files / ## IDE Context / ## User's Current IDE Context / ## Active Terminal Session）。
 * 与 IDEA 宿主 SessionContextService.buildCodexContextAppend 保持完全一致的协议。
 */
function buildContextAppend(
	payload: SendMessagePayload,
	autoOpenFileOn: boolean,
	selInfo: string | null,
): string {
	let contextAppend = '';

	// 1. @ 引用的文件与终端
	const regularFilePaths: string[] = [];
	const terminalPaths: string[] = [];
	if (Array.isArray(payload.fileTags) && payload.fileTags.length > 0) {
		for (const tag of payload.fileTags) {
			const p = tag?.absolutePath || tag?.displayPath;
			if (p) {
				if (p.startsWith('terminal://')) {
					terminalPaths.push(p);
				} else {
					regularFilePaths.push(p);
				}
			}
		}
	}

	if (terminalPaths.length > 0) {
		contextAppend += '\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n';
		for (const terminalPath of terminalPaths) {
			const sessionName = terminalPath.substring('terminal://'.length);
			contextAppend += `- **Terminal**: \`${sessionName}\`\n`;
		}
		contextAppend += '\nCommands should be executed in this terminal context.\n';
	}

	if (regularFilePaths.length > 0) {
		contextAppend += '\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n';
		for (const filePath of regularFilePaths) {
			contextAppend += `- \`${filePath}\`\n`;
		}
		contextAppend += "\nRead them with your file tools as needed; the user expects answers based on their content.\n";
	}

	// 2. 编辑器上下文（活动文件与选区）
	if (autoOpenFileOn && selInfo) {
		const m = /^@(.+?)(?:#L(\d+)(?:-(\d+))?)?$/.exec(selInfo);
		if (m?.[1]) {
			const activeFile = m[1];
			const startLine = m[2];
			const endLine = m[3] || startLine;
			if (startLine && endLine) {
				const lineRange = startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`;
				contextAppend += `\n\n## IDE Context\n\nActive file: \`${activeFile}${lineRange}\`\n\nThe user has selected the referenced lines in this file; the selection is the primary subject of the user's question. Read the file to see the selected code.\n`;
			} else {
				contextAppend += `\n\n## User's Current IDE Context\n\nThe user is viewing this file in their IDE. This is the PRIMARY SUBJECT of the user's question: \`${activeFile}\`\n\nRead it with your file tools as needed.\n`;
			}
		}
	}

	return contextAppend;
}
