/**
 * OpenCodeSession — TS 版会话编排，对应 cc-gui `ClaudeSession` + `SessionSendService`。
 * 只保留 opencode：send 走 daemon 的 `opencode.send`（常驻 serve + SDK），
 * 输出 marker 行经 MarkerParser → MessageHandler 状态机 → SessionCallbackAdapter
 * → window.<fn> 推送 webview。
 */
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { HandlerContext } from '../router/HandlerContext';
import { SessionState, createMessage } from './SessionState';
import { CallbackHandler } from './CallbackHandler';
import { MessageHandler } from './MessageHandler';
import { MarkerStreamContext, processOutputLine } from './MarkerParser';
import { SessionCallbackAdapter } from './SessionCallbackAdapter';
import { MessageType } from './types';
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
			streamEndCallback: () => this.onTurnEnded(),
			permissionHandler: (request) => this.permissionHandler?.(request),
			permissionClosedHandler: (kind, content) => this.permissionClosedHandler?.(kind, content),
		});
		this.callbackHandler.setCallback(this.adapter);
	}

	getAdapter(): SessionCallbackAdapter {
		return this.adapter;
	}

	/**
	 * 发送一条消息。non-blocking；结果经流管道异步回传 webview。
	 */
	async send(payload: SendMessagePayload): Promise<void> {
		let text = payload.text ?? '';
		const cwd = this.state.getCwd() ?? this.context.resolveEffectiveWorkingDirectory() ?? undefined;

		// opencode 原生斜杠命令：'/name args...' → 走 /session/{id}/command。
		// 与 TUI 一致，任何前导 '/' 文本都视为命令（未知命令由服务端报错）。
		const slashCommand = parseSlashCommand(text);

		// cc-gui 语义：每次发送附带当前编辑器上下文。opencode 侧等价于在消息里
		// @ 该文件 —— 注入路径引用，agent 会自行读取文件（含选区行号提示）。
		// 斜杠命令不注入（命令参数语义会被污染）。
		// 发送前实时校验 autoOpenFileEnabled：resolver 缓存可能在设置关闭后
		// 尚未被编辑器事件刷新（双保险，主清除路径在 SettingsHandler）。
		const injectProjectPath = this.context.getSettingsService().getPrimaryWorkspaceRoot();
		const autoOpenFileOn = !injectProjectPath
			|| this.context.getSettingsService().getAutoOpenFileEnabled(injectProjectPath);
		if (!slashCommand && autoOpenFileOn) {
			const selInfo = this.editorSelectionResolver?.() ?? null;
			if (selInfo) {
				const m = /^@(.+?)(?:#L(\d+)(?:-(\d+))?)?$/.exec(selInfo);
				if (m?.[1]) {
					const lines = m[2] && m[3] && m[2] !== m[3] ? ` (lines ${m[2]}-${m[3]})` : '';
					text = `${text}\n\n@${m[1]}${lines}`.trim();
				}
			}
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
				: { message: text }),
			model: this.state.getModel() ?? undefined,
			mode: mapPermissionModeToAgent(this.state.getPermissionMode()),
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
			mode: mapPermissionModeToAgent(this.state.getPermissionMode()),
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
			messageCount: this.state.getMessages().length,
			status,
		});
	}

	interrupt(): void {
		this.state.setBusy(false);
		this.state.setLoading(false);
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
		this.state.setSessionId(null);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.setError(null);
		this.state.setRevertState(null);
		// 新会话无 redo 状态，同步前端隐藏 Redo 按钮
		this.context.callJavaScript('onRevertStateUpdate', JSON.stringify({ hasRevert: false }));
		this.onSessionEnded?.();
	}

	/** 从历史恢复：替换当前消息列表并推送。 */
	restoreMessages(messages: unknown[]): void {
		// resetStreamState 会抬高 webview 的 __minAcceptedUpdateSequence 屏障，
		// 因此 clear/update 必须复用它返回的新序号（'0' 会被屏障丢弃 → 空屏）。
		const seq = this.adapter.coalescer.resetStreamState();
		this.state.clearMessages();
		// 回填宿主侧消息列表：后续 send 的快照必须包含完整历史，否则
		// webview 的收缩保护（preserveLatestMessagesOnShrink）会把新发送的
		// 用户气泡与历史错位重排，表现为"消息气泡出现后立即消失"。
		for (const m of messages) {
			this.state.addMessage(m as ChatMessage);
		}
		this.context.callJavaScript('clearMessages', String(seq));
		this.context.callJavaScript('updateMessages', JSON.stringify(messages), String(seq));
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

/**
 * 把 UI 的 permissionMode（opencode 专属模式列表，见 webview OPENCODE_MODES）
 * 映射为 opencode agent 名（SDK 语义）。opencode 内置 agent：
 * build（默认全权限开发）/ plan（只读规划）。
 */
function mapPermissionModeToAgent(mode: string): string | undefined {
	switch (mode) {
		case 'plan':
			return 'plan';
		default:
			// 显式指定 build：从 plan 切回时确保恢复默认开发 agent。
			return 'build';
	}
}

/** cc-gui summary 截断（45 字符 + 省略号）。 */
function truncateSummary(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 45) {
		return trimmed;
	}
	return `${trimmed.slice(0, 45)}...`;
}

/** 把 webview 的 attachments / fileTags 归一成 daemon `opencode.send` 的附件。 */
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

	if (Array.isArray(payload.fileTags) && payload.fileTags.length > 0) {
		for (const tag of payload.fileTags) {
			if (tag?.absolutePath) {
				result.push({
					type: 'file',
					path: tag.absolutePath,
					name: tag.displayPath,
					description: 'referenced-file',
				});
			}
		}
	}

	return result;
}
