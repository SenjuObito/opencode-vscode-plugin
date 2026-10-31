/**
 * OpenCodeSession — TS 版会话编排，对应 cc-gui `ClaudeSession` + `SessionSendService`。
 * 只保留 opencode：send 走 daemon 的 `opencode.send`（常驻 serve + SDK），
 * 输出 marker 行经 MarkerParser → MessageHandler 状态机 → SessionCallbackAdapter
 * → window.<fn> 推送 webview。
 */
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { HandlerContext } from '../router/HandlerContext';
import { SessionState, createMessage, normalizePermissionMode, normalizeRequestedReasoningEffort } from './SessionState';
import { CallbackHandler } from './CallbackHandler';
import { MessageHandler } from './MessageHandler';
import { MarkerStreamContext, processOutputLine } from './MarkerParser';
import { SessionCallbackAdapter, JsTarget } from './SessionCallbackAdapter';
import { SessionHistoryWindow } from './SessionHistoryWindow';
import { MessageType } from './types';
import { extractContextTokens, findLastUsageFromMessages } from '../util/TokenUsageUtils';
import { getModelContextLimit } from '../util/ModelContextLimits';
import { logDiagnostic } from '../util/DiagnosticLogger';
import type { TabEventSink } from '../tab/TabEvent';
import { isKnownSlashCommand } from './KnownCommands';
import { isAdvertisedCommand } from '../util/SlashCommandCatalog';
import type { ChatMessage, PermissionRequest, SessionCallback } from './types';

/** webview `session.send` 的 payload。 */
export interface SendMessagePayload {
	text: string;
	attachments?: Array<{
		/** 宿主侧已落盘的附件 id（多 tab 附件链路）；存在时不带 data。 */
		attachmentId?: string;
		fileName?: string;
		mediaType?: string;
		data?: string;
	}>;
	fileTags?: Array<{ displayPath?: string; absolutePath?: string }> | null;
	permissionMode?: string;
	reasoningEffort?: string;
	/**
	 * 本次发送要用的模型（`provider/model`）。
	 *
	 * <p>模型随**每一次发送**下发，而不是只靠 `settings.model` 写入会话状态：
	 * 新建 tab 在首条消息之前根本没有会话可写（`handleModelSelect` 会跳过），
	 * 只靠状态同步就会让首轮用上全局默认模型 —— idea 的 `SessionHandler` 同样
	 * 从 payload 读 `model`。</p>
	 */
	model?: string;
}

export interface OpenCodeSessionOptions {
	context: HandlerContext;
	daemon: OpenCodeDaemonBridge;
	/** 会话结束时（如新会话 / 销毁）额外清理钩子。 */
	onSessionEnded?: () => void;
	/** 权限/提问请求处理（Phase 4 接 webview 弹层）。 */
	permissionHandler?: (request: PermissionRequest) => void;
	/** 服务端已答复/取消未决 prompt（同步关闭 webview 卡片）。 */
	permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	/** 每个流式 turn 结束时回调（用于登记会话历史 + 任务完成/警示通知）。 */
	onTurnCompleted?: (info: TurnCompletedInfo) => void;
	/** 发送时解析当前编辑器上下文（'@path#L1-L2'），cc-gui EditorContextCollector 等价物。 */
	editorSelectionResolver?: () => string | null;
	/**
	 * 本会话的所有 webview 输出目标。
	 *
	 * 单会话时代输出直接走 `context.callJavaScript`（等于广播到所有面板）。
	 * 多 tab 后每个 tab 的输出必须带上自己的归属：`ChatWindow` 会传入一个
	 * 按活跃 tab 投影的 sink，后台 tab 的输出被丢弃、切回时用宿主状态回放。
	 * 缺省仍退回 `context.callJavaScript`（单会话/测试路径）。
	 */
	viewSink?: JsTarget;
	/**
	 * 本 tab 的「自动打开文件」开关（§10.12）。
	 *
	 * 返回 null/undefined = 本 tab 没有单独设置，继续用全局项目设置；
	 * 返回 true/false = 本 tab 自己的决定（每个 tab 可以不同）。
	 */
	autoOpenFileEnabledResolver?: () => boolean | null | undefined;
	/**
	 * 本 tab 是否注入 IDE 上下文（§10.12 `TabSettings.contextEnabled`）。
	 * 关闭后不再带活动文件/选区；显式 @ 引用仍然生效。
	 */
	contextEnabledResolver?: () => boolean;
	/** 本 tab 的命名事件出口（未提供时退回 legacy JS 调用）。 */
	eventSink?: TabEventSink;
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
	/**
	 * 本标签页从服务端读回了多少历史（opencode 2.x 分页）。
	 *
	 * <p>会话与 tab 一一对应，所以游标属于会话：两个 tab 打开同一份历史时
	 * 各自翻页，不会把对方的游标带到自己的转录上。</p>
	 */
	readonly historyWindow = new SessionHistoryWindow();
	private readonly context: HandlerContext;
	private readonly daemon: OpenCodeDaemonBridge;
	private readonly callbackHandler: CallbackHandler;
	private readonly messageHandler: MessageHandler;
	private readonly adapter: SessionCallbackAdapter;
	private readonly onSessionEnded?: () => void;
	private readonly permissionHandler?: (request: PermissionRequest) => void;
	private readonly permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	private readonly onTurnCompleted?: (info: TurnCompletedInfo) => void;
	private readonly editorSelectionResolver?: () => string | null;
	/** 本会话的输出目标（按 tab 归属），缺省广播到 context。 */
	private readonly view: JsTarget;

	// 单轮流式状态（由 MarkerParser 维护）
	private streamCtx: MarkerStreamContext = {
		assistantContent: '',
		hadSendError: false,
		lastNodeError: null,
		wasAborted: false,
	};
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
		this.autoOpenFileEnabledResolver = options.autoOpenFileEnabledResolver;
		this.contextEnabledResolver = options.contextEnabledResolver;
		this.view = options.viewSink ?? {
			callJavaScript: (fn, ...args) => this.context.callJavaScript(fn, ...args),
		};

		this.callbackHandler = new CallbackHandler();
		this.messageHandler = new MessageHandler(this.state, this.callbackHandler);
		this.adapter = new SessionCallbackAdapter({
			jsTarget: this.view,
			eventSink: options.eventSink,
			model: () => this.state.getModel(),
			windowBaseIndex: () => this.state.getWindowBaseIndex(),
			streamEndCallback: () => this.onTurnEnded(),
			permissionHandler: (request) => this.permissionHandler?.(request),
			permissionClosedHandler: (kind, content) => this.permissionClosedHandler?.(kind, content),
		});
		this.callbackHandler.setCallback(this.adapter);
	}

	hasActiveRequest(): boolean {
		return this.activeRequestId !== null;
	}

	getActiveRequestId(): string | null {
		return this.activeRequestId;
	}

	getState(): SessionState {
		return this.state;
	}

	setCallback(callback: SessionCallback): void {
		this.callbackHandler.setCallback(callback);
	}

	getAdapter(): SessionCallbackAdapter {
		return this.adapter;
	}

	private readonly autoOpenFileEnabledResolver?: () => boolean | null | undefined;
	private readonly contextEnabledResolver?: () => boolean;


	/**
	 * 发送一条消息。non-blocking；结果经流管道异步回传 webview。
	 */
	async send(payload: SendMessagePayload): Promise<void> {
		const text = payload.text ?? '';
		const cwd = this.state.getCwd() ?? this.context.resolveEffectiveWorkingDirectory() ?? undefined;

		// opencode 原生斜杠命令：'/name args...' → 走 /session/{id}/command。
		// 与 TUI 一致，任何前导 '/' 文本都视为命令（未知命令由服务端报错）。
		const slashCommand = parseSlashCommand(text);

		const injectProjectPath = this.context.getSettingsService().getPrimaryWorkspaceRoot();
		// per-tab 优先：tab 自己设过就用 tab 的，没设过才用全局项目设置。
		const tabAutoOpenFile = this.autoOpenFileEnabledResolver?.();
		const autoOpenFileOn = tabAutoOpenFile !== undefined && tabAutoOpenFile !== null
			? tabAutoOpenFile
			: (!injectProjectPath
				|| this.context.getSettingsService().getAutoOpenFileEnabled(injectProjectPath));
		// §10.12：tab 的上下文开关关闭时，不注入活动文件/选区；显式 @ 引用不受影响。
		const contextEnabled = this.contextEnabledResolver?.() ?? true;
		const selInfo = contextEnabled ? (this.editorSelectionResolver?.() ?? null) : null;

		let messageToSend = text;
		if (!slashCommand) {
			const contextAppend = buildContextAppend(payload, contextEnabled && autoOpenFileOn, selInfo);
			messageToSend = (text ? text : '') + contextAppend;
		}

		// 更新会话配置（model / permissionMode / reasoningEffort 来自 payload）
		if (payload.model) {
			this.state.setModel(payload.model);
		}
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

		this.streamCtx = {
			assistantContent: '',
			hadSendError: false,
			lastNodeError: null,
			wasAborted: false,
		};

		const params: Record<string, unknown> = {
			sessionId: this.state.getSessionId() ?? undefined,
			...(slashCommand
				? { command: slashCommand.command, commandArguments: slashCommand.arguments }
				: { message: messageToSend }),
			model: this.state.getModel() ?? undefined,
			mode: normalizePermissionMode(this.state.getPermissionMode()) ?? undefined,
			reasoningEffort: normalizeRequestedReasoningEffort(this.state.getReasoningEffort()),
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
				this.streamCtx.wasAborted = true;
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

		this.streamCtx = {
			assistantContent: '',
			hadSendError: false,
			lastNodeError: null,
			wasAborted: false,
		};

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
				this.streamCtx.wasAborted = true;
				this.messageHandler.onComplete({ messages: this.state.getMessages(), success: false });
			},
		});
	}

	processLine(line: string): void {
		processOutputLine(line, this.messageHandler, this.streamCtx);
	}

	/**
	 * 历史恢复后补发子代理终态。
	 *
	 * <p>持久化 transcript 只保留启动 ack，重开会话时子代理可能早已结束。
	 * core 的 `getSessionSubagents` 给出权威终态，这里把它交给与实时事件完全
	 * 相同的 callback 链，避免在 webview 里再写一套恢复逻辑。</p>
	 */
	notifySubagentStatus(payload: Record<string, unknown>): void {
		this.callbackHandler.notifySubagentStatus(JSON.stringify(payload));
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

	/**
	 * 用户主动中断（停止按钮）。语义对齐 idea `OpencodeSession#interrupt`：
	 *
	 * 1. 先打「本回合是用户主动中断」的标记 —— `MarkerParser` 据此抑制服务端
	 *    随中断回来的 `[SEND_ERROR]` / `[TURN_ERROR]`（"Step interrupted" 不是
	 *    失败，不该变成一条 ERROR 气泡）。
	 * 2. 清错误、落 busy/loading，并推一次权威状态（前端 `interruptSession`
	 *    已自行清掉流式缓冲与 loading，这里补宿主侧的一致状态）。
	 * 3. **故意不 notifyStreamEnd**（与 idea 相同的三条理由）：本地收尾会触发
	 *    消息快照回放，与随后到达的 `[STREAM_END]` / `[TURN_END]` 打架 ——
	 *    收尾统一由 daemon 的终止信号驱动。
	 */
	interrupt(): void {
		this.streamCtx.wasAborted = true;
		this.state.setError(null);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.updateLastModifiedTime();
		this.adapter.onStateChange(false, false, null);

		const sessionId = this.state.getSessionId() ?? undefined;
		const requestId = this.activeRequestId ?? undefined;
		this.activeRequestId = null;
		this.daemon.sendAbort(sessionId, requestId);
	}

	/**
	 * 视图就绪对齐（方案 B）。
	 *
	 * 每个新建的 webview 只会发一次 `frontend_ready`（`main.tsx` 里 waitForBridge
	 * 回调），因此收到它就意味着「刚出现了一个空视图」。而宿主内存里的 state
	 * 可能还留着上一会话的整份消息——两者不一致就会表现为：
	 * 打开插件看到空对话（视图是空的），发第一条消息后旧对话立刻冒出来
	 * （send() 会把 state.getMessages() 整份推给视图）。
	 *
	 * 这里在回放任何状态之前先把两者对齐：
	 *
	 * - 只有这一个存活视图：清空宿主内存 → 名副其实的「新会话」。旧会话仍在
	 *   opencode 服务端，可从历史列表随时重新打开，不会丢。
	 * - 已有别的视图在展示当前会话（侧边栏 + 编辑器分栏共享同一会话）：不能清，
	 *   否则会把另一个视图正在看的对话擦掉；改为把宿主快照补推给新视图。
	 * - 流式进行中：不动。流式快照本来就会广播给所有存活视图。
	 * @returns 是否把会话清成了新会话（true 表示宿主已不再持有任何会话，
	 *   调用方不应再向视图回放旧的 sessionId）。
	 */
	reconcileWithFreshView(): boolean {
		const messages = this.state.getMessages();
		const hasSession = this.state.getSessionId() != null || messages.length > 0;
		if (!hasSession || this.state.isBusy()) {
			return false;
		}
		if (this.context.getViewCount() > 1) {
			this.restoreMessages(messages);
			return false;
		}
		this.resetSession();
		return true;
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
		this.adapter.notifyMessagesCleared(seq);
		this.state.clearMessages();
		// 新对话没有历史窗口：带着旧窗口会让「还有更早」按钮继续指向旧会话。
		this.historyWindow.reset(null);
		this.messageHandler.resetTurnState();
		this.state.setSessionId(null);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.setError(null);
		this.state.setRevertState(null);
		// 新会话无 redo 状态，同步前端隐藏 Redo 按钮
		this.adapter.onRevertStateUpdate(false);
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
		this.adapter.notifyMessagesCleared(seq);
		this.adapter.onMessageUpdate(this.state.getMessages());
		this.adapter.getCoalescer().flush();

		// 恢复历史 Token 统计
		this.republishUsageFromHistory();
	}

	/**
	 * 前插一页更早的历史，并且只把这**一页**推给 webview。
	 *
	 * <p>不发整份快照是有意的：整表替换会让滚动位置失去锚点。webview 侧按
	 * message key 去重后前插，滚动调整交给它自己。</p>
	 *
	 * @returns 实际前插的条数（0 = 该页被服务端过滤成空）
	 */
	prependHistoryMessages(messages: unknown[]): number {
		const stored = this.state.prependMessages(messages as ChatMessage[]);
		if (stored.length > 0) {
			this.adapter.onMessagesPrepended(stored);
		}
		return stored.length;
	}

	/** 把本 tab 的历史窗口状态推给 webview（`history.window`）。 */
	publishHistoryWindow(): void {
		this.adapter.onHistoryWindowChanged(this.historyWindow.snapshot(this.state.getSessionId()));
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
/**
 * 识别一条消息是不是 opencode 斜杠命令。
 *
 * 命中的条件（与 idea 一致）：命令名在已知命令表里，**或者**服务端公布过它
 * （自定义命令）。都不命中就按普通消息处理 —— 这样 `/Users/...`、`/v2/...`
 * 这类路径不会被当成命令，也不会因此丢掉编辑器上下文。
 */
export function parseSlashCommand(text: string): { command: string; arguments: string } | null {
	const trimmed = text.trim();
	const m = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!m || !m[1]) {
		return null;
	}
	if (!isKnownSlashCommand(m[1]) && !isAdvertisedCommand(m[1])) {
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
