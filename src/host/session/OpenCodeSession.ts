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
import { SessionCallbackAdapter } from './SessionCallbackAdapter';
import { MessageType } from './types';
import { convertMessagesToJson } from '../util/MessageJsonConverter';
import { ListMessagesCollector, type EntryRetention } from '../util/ListMessagesCollector';
import { convertSdkMessages } from './SdkMessageConverter';
import type { ChatMessage, PermissionRequest } from './types';

/** webview send_message / send_message_with_attachments 的 payload。 */
export interface SendMessagePayload {
	text: string;
	attachments?: Array<{ fileName?: string; mediaType?: string; data?: string }>;
	fileTags?: Array<{ displayPath?: string; absolutePath?: string }> | null;
	permissionMode?: string;
	reasoningEffort?: string;
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
}

export type TurnCompletedStatus = 'completed' | 'aborted' | 'error';

export interface TurnCompletedInfo {
	sessionId: string | null;
	title: string;
	messageCount: number;
	/** completed=正常结束；aborted=用户手动中断；error=轮次执行出错。 */
	status: TurnCompletedStatus;
}

/** 每次「加载更早消息」前插的条数。 */
export const RESTORE_PAGE_MESSAGES = 200;
/** 回源转换缓存 TTL：分页连点时避免重复全量拉取；超时后重新回源。 */

export class OpenCodeSession {
	readonly state = new SessionState();
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

	// 单轮流式状态（由 MarkerParser 维护）
	private streamCtx: MarkerStreamContext = {
		assistantContent: '',
		hadSendError: false,
		lastNodeError: null,
		wasAborted: false,
	};

	// ── 分页/回源状态 ──
	// earlierCursor：webview 已加载内容的最早全局序号（分页游标）。
	// restore 时 = transcript 窗口基址；前插后前移；逐出不改变它（webview
	// 已装入的内容不随宿主逐出消失）；webview 裁剪分页时经 setEarlierCursor
	// 回滚（该区间可重新回源）。
	private earlierCursor = 0;
	private earlierFetchInFlight = false;

	constructor(options: OpenCodeSessionOptions) {
		this.context = options.context;
		this.daemon = options.daemon;
		this.onSessionEnded = options.onSessionEnded;
		this.permissionHandler = options.permissionHandler;
		this.permissionClosedHandler = options.permissionClosedHandler;
		this.onTurnCompleted = options.onTurnCompleted;
		this.editorSelectionResolver = options.editorSelectionResolver;

		this.callbackHandler = new CallbackHandler();
		this.messageHandler = new MessageHandler(this.state, this.callbackHandler);
		this.adapter = new SessionCallbackAdapter({
			jsTarget: {
				callJavaScript: (fn, ...args) => this.context.callJavaScript(fn, ...args),
			},
			model: () => this.state.getModel(),
			windowBaseIndex: () => this.state.getWindowBaseIndex(),
			streamEndCallback: () => this.onTurnEnded(),
			permissionHandler: (request) => this.permissionHandler?.(request),
			permissionClosedHandler: (kind, content) => this.permissionClosedHandler?.(kind, content),
		});
		this.callbackHandler.setCallback(this.adapter);

		// 活跃会话窗口滑动（逐出发生）→ 通知 webview 更新「加载更早」状态。
		this.state.setOnWindowChanged(() => {
			this.pushHistoryWindowInfo();
		});
	}

	getAdapter(): SessionCallbackAdapter {
		return this.adapter;
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

		const injectProjectPath = this.context.getSettingsService().getPrimaryWorkspaceRoot();
		const autoOpenFileOn = !injectProjectPath
			|| this.context.getSettingsService().getAutoOpenFileEnabled(injectProjectPath);
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
			reasoningEffort: this.state.getReasoningEffort() ?? undefined,
			cwd: cwd ?? undefined,
			attachments: attachments.length > 0 ? attachments : undefined,
		};

		await this.daemon.request('opencode.send', params, {
			onLine: (line) => this.processLine(line),
			onStderr: (stderr) => {
				// stderr 仅记录，不打断流
			},
			onError: (error) => {
				this.messageHandler.onError(error);
			},
			onComplete: (success) => {
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
			onLine: (line) => this.processLine(line),
			onStderr: () => {},
			onError: (error) => {
				this.messageHandler.onError(error);
			},
			onComplete: (success) => {
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
				this.streamCtx.wasAborted = true;
				this.messageHandler.onComplete({ messages: this.state.getMessages(), success: false });
			},
		});
	}

	private processLine(line: string): void {
		processOutputLine(line, this.messageHandler, this.streamCtx);
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
		this.daemon.sendAbort();
	}

	/**
	 * 新建会话：重置状态并建立新会话（daemon 侧 SDK createSession 会在
	 * [MESSAGE_START] 里回传新的 session_id）。
	 */
	resetSession(): void {
		const seq = this.adapter.coalescer.resetStreamState();
		this.context.callJavaScript('clearMessages', String(seq));
		this.state.clearMessages();
		this.messageHandler.resetTurnState();
		this.earlierCursor = 0;
		this.state.setSessionId(null);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.setError(null);
		this.state.setRevertState(null);
		// 新会话无 redo 状态，同步前端隐藏 Redo 按钮
		this.context.callJavaScript('onRevertStateUpdate', JSON.stringify({ hasRevert: false }));
		this.onSessionEnded?.();
	}

	/** 从历史恢复：collector 已按 tail 窗口保留，直接采纳窗口与全量元数据。 */
	restoreMessages(
		messages: unknown[],
		origin?: { firstIndex: number; total: number },
	): void {
		// resetStreamState 会抬高 webview 的 __minAcceptedUpdateSequence 屏障，
		// 因此 clear/update 必须复用它返回的新序号（'0' 会被屏障丢弃 → 空屏）。
		const seq = this.adapter.coalescer.resetStreamState();
		this.state.clearMessages();
		for (const m of messages) {
			this.state.addMessage(m as ChatMessage);
		}
		if (origin) {
			this.state.adoptTranscriptWindow(origin.firstIndex, origin.total);
		}
		this.earlierCursor = this.state.getWindowBaseIndex();
		this.context.callJavaScript('clearMessages', String(seq));
		// 推送走 convertMessagesToJson（tool_result 20K / 错误文本 1K 截断）；
		// 第三个参数把窗口基址（全局序号）告知 webview 做窗口对齐。
		this.context.callJavaScript(
			'updateMessages',
			convertMessagesToJson(this.state.getMessages()),
			String(seq),
			String(this.state.getWindowBaseIndex()),
		);
		this.pushHistoryWindowInfo();
	}

	/**
	 * webview 请求更早的历史（异步回源）：以 range 保留模式从 daemon 拉
	 * [pageStart, earlierCursor) 区间——全量 transcript 在解析管道中流过即弃，
	 * 宿主只持有该页。transcript 收缩（revert/compact）时按全量总数对齐。
	 */
	async loadEarlierMessages(count = RESTORE_PAGE_MESSAGES): Promise<void> {
		const sessionId = this.state.getSessionId();
		if (!sessionId || this.earlierCursor <= 0 || this.earlierFetchInFlight) {
			this.pushHistoryWindowInfo();
			return;
		}
		this.earlierFetchInFlight = true;
		try {
			const pageEnd = this.earlierCursor;
			const pageStart = Math.max(0, pageEnd - Math.max(1, count));
			const collector = await this.requestTranscriptWindow(sessionId, {
				mode: 'range',
				start: pageStart,
				end: pageEnd,
			});
			const windowLength = this.state.getMessages().length;
			const safePageEnd = Math.min(pageEnd, Math.max(0, collector.getTotalMessageCount() - windowLength));
			if (safePageEnd <= 0) {
				this.earlierCursor = 0;
				this.pushHistoryWindowInfo();
				return;
			}
			const firstRetained = collector.getFirstRetainedMessageIndex();
			const begin = Math.max(0, pageStart - firstRetained);
			// range 保留按 entry 粒度，边界 entry 可能带出区间外的消息——按
			// 全局序号精确切片。
			const page = convertSdkMessages(collector.getEntries())
				.slice(begin, Math.max(begin, safePageEnd - firstRetained));
			if (page.length > 0) {
				const servedStart = firstRetained + begin;
				this.earlierCursor = servedStart;
				// 第二个参数：页起点全局序号，webview 用它对齐列表起始位置。
				this.context.callJavaScript(
					'updateMessagesPrepend',
					convertMessagesToJson(page),
					String(servedStart),
				);
			} else {
				this.earlierCursor = Math.min(this.earlierCursor, safePageEnd);
			}
			this.pushHistoryWindowInfo();
		} finally {
			this.earlierFetchInFlight = false;
		}
	}

	/** 分页被 webview 裁剪（累积上限）时回滚游标：该区间下次可重新回源。 */
	setEarlierCursor(cursor: number): void {
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			return;
		}
		this.earlierCursor = Math.max(this.earlierCursor, Math.min(cursor, this.state.getWindowBaseIndex()));
		this.pushHistoryWindowInfo();
	}

	/** 按 range/tail 保留模式拉取 transcript 窗口（即弃，不缓存）。 */
	private requestTranscriptWindow(
		sessionId: string,
		retention: EntryRetention,
	): Promise<ListMessagesCollector> {
		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		return new Promise((resolve) => {
			const collector = new ListMessagesCollector(retention);
			const ok = this.daemon.request('opencode.listMessages', { sessionId, directory }, {
				onLine: (line) => collector.onLine(line),
				onError: () => resolve(collector),
				onComplete: () => {
					collector.reconcileFallback();
					resolve(collector);
				},
			});
			if (!ok) {
				resolve(collector);
			}
		});
	}

	private pushHistoryWindowInfo(): void {
		this.context.callJavaScript(
			'onHistoryWindowInfo',
			JSON.stringify({
				sessionId: this.state.getSessionId(),
				hasEarlier: this.earlierCursor > 0,
				windowStart: this.earlierCursor,
				total: this.state.getTotalCount(),
			}),
		);
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

/** 解析前导斜杠命令：'/name args...' → {command, arguments}；非命令返回 null。 */
function parseSlashCommand(text: string): { command: string; arguments: string } | null {
	const trimmed = text.trim();
	const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
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
