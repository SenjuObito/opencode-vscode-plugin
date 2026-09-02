/**
 * MessageHandler — port of cc-gui `session/ClaudeMessageHandler.java`.
 * State machine for the opencode stream: assembles assistant messages from
 * marker-protocol events (content/thinking deltas, tool results, usage),
 * dedups replayed deltas, and drives the CallbackHandler.
 */
import {
	isObject,
	isArray,
	getObj,
	getObjArray,
	getString,
	JsonObject,
	JsonArray,
} from './jsonUtils';
import { ChatMessage, MessageType } from './types';
import { SessionState, createMessage } from './SessionState';
import { CallbackHandler } from './CallbackHandler';
import { MessageParser } from './MessageParser';
import { MessageMerger } from './MessageMerger';
import { ReplayDeduplicator } from './ReplayDeduplicator';
import { extractContextTokens } from '../util/TokenUsageUtils';
import { getModelContextLimit } from '../util/ModelContextLimits';
import { logDiagnostic } from '../util/DiagnosticLogger';

/** Minimal SDKResult: the daemon's per-turn aggregate. */
export interface SDKResult {
	messages: unknown[];
	success: boolean;
	error?: string | null;
	usage?: unknown;
}

export interface MessageCallback {
	onMessage(type: string, content: string): void;
	onError(error: string): void;
	onComplete(result: SDKResult): void;
}

export class MessageHandler implements MessageCallback {
	private readonly state: SessionState;
	private readonly callbackHandler: CallbackHandler;
	private readonly messageParser = new MessageParser();
	private readonly messageMerger = new MessageMerger();
	private readonly replayDedup = new ReplayDeduplicator();

	// 当前 assistant 消息的内容累加器
	private assistantContent = '';
	// 当前正在处理的 assistant 消息
	private currentAssistantMessage: ChatMessage | null = null;
	private isThinking = false;

	private isStreaming = false;
	private streamEndedThisTurn = false;
	private errorReportedThisTurn = false;
	private lastReportedError: string | null = null;

	// 流式分段状态（围绕 tool 调用切分 text/thinking）
	private textSegmentActive = false;
	private thinkingSegmentActive = false;

	constructor(state: SessionState, callbackHandler: CallbackHandler) {
		this.state = state;
		this.callbackHandler = callbackHandler;
	}

	private resetSegmentState(): void {
		this.textSegmentActive = false;
		this.thinkingSegmentActive = false;
		this.replayDedup.reset();
	}

	/**
	 * 重置单轮 assistant 累加器，避免新一轮 delta 追加到上一轮的消息上
	 * （assistantContent / currentAssistantMessage 是实例字段，跨轮不复位
	 * 会导致历史消息被原地改写并逐轮累加）。
	 */
	resetTurnState(): void {
		this.assistantContent = '';
		this.currentAssistantMessage = null;
		this.isThinking = false;
		this.resetSegmentState();
	}

	// =========================================================================
	// MessageCallback
	// =========================================================================

	onMessage(type: string, content: string): void {
		switch (type) {
			case 'user':
				this.handleUserMessage(content);
				break;
			case 'assistant':
				this.handleAssistantMessage(content);
				break;
			case 'thinking':
				this.handleThinkingMessage();
				break;
			case 'content':
				this.handleContent(content);
				break;
			case 'content_delta':
				this.handleContentDelta(content);
				break;
			case 'thinking_delta':
				this.handleThinkingDelta(content);
				break;
			case 'stream_start':
				this.handleStreamStart();
				break;
			case 'stream_end':
				this.handleStreamEnd();
				break;
			case 'block_reset':
				this.handleBlockReset();
				break;
			case 'session_id':
				this.handleSessionId(content);
				break;
			case 'tool_result':
				this.handleToolResult(content);
				break;
			case 'message_end':
				this.handleMessageEnd();
				break;
			case 'result':
				this.handleResult(content);
				break;
			case 'usage':
				this.handleUsage(content);
				break;
			case 'revert_state':
				this.handleRevertState(content);
				break;
			case 'slash_commands':
				this.handleSlashCommands(content);
				break;
			case 'system':
				this.handleSystemMessage(content);
				break;
			case 'node_log':
				this.callbackHandler.notifyNodeLog(content);
				break;
		case 'permission_request':
			logDiagnostic(`[MessageHandler] permission_request content=${content.substring(0, 200)}`);
			this.handlePermissionRequest(content, false);
			break;
		case 'question_request':
			logDiagnostic(`[MessageHandler] question_request content=${content.substring(0, 500)}`);
			this.handlePermissionRequest(content, true);
			break;
		case 'question_closed':
			logDiagnostic(`[MessageHandler] question_closed content=${content}`);
			this.callbackHandler.notifyPermissionClosed('question', content);
			break;
		case 'permission_closed':
			logDiagnostic(`[MessageHandler] permission_closed content=${content}`);
			this.callbackHandler.notifyPermissionClosed('permission', content);
			break;
		case 'todo_updated':
			logDiagnostic(`[MessageHandler] todo_updated content=${content.substring(0, 300)}`);
			this.callbackHandler.notifyTodoUpdated(content);
			break;
		}
	}

	onError(error: string): void {
		if (this.errorReportedThisTurn && error !== null && error === this.lastReportedError) {
			return;
		}

		this.isStreaming = false;
		this.streamEndedThisTurn = false;
		this.errorReportedThisTurn = true;
		this.lastReportedError = error;
		this.resetSegmentState();

		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}

		this.state.setError(error);
		this.state.setBusy(false);
		this.state.setLoading(false);

		const errorMessage = createMessage(MessageType.ERROR, error);
		this.state.addMessage(errorMessage);

		// 先 signal stream-end 再推错误快照（与 Java 一致，顺序关键）。
		this.callbackHandler.notifyStreamEnd();
		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
	}

	onComplete(result: SDKResult): void {
		if (this.streamEndedThisTurn) {
			this.streamEndedThisTurn = false;
			this.errorReportedThisTurn = false;
			this.lastReportedError = null;
			this.state.setBusy(false);
			this.state.setLoading(false);
			this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
			return;
		}

		// 如果本轮已经通过 onError 处理过错误，只做清理，不再重复通知状态
		if (this.errorReportedThisTurn) {
			this.errorReportedThisTurn = false;
			this.lastReportedError = null;
			this.state.setBusy(false);
			this.state.setLoading(false);
			return;
		}

		// 流式活跃但 [STREAM_END] 未收到（SDK 错误/超时/进程中断）——强制收尾。
		const wasStreaming = this.isStreaming;
		this.isStreaming = false;
		this.resetSegmentState();

		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}

		this.errorReportedThisTurn = false;
		this.lastReportedError = null;
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.updateLastModifiedTime();

		if (wasStreaming) {
			this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
			this.callbackHandler.notifyStreamEnd();
		}

		this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
	}

	// =========================================================================
	// 各消息类型处理
	// =========================================================================

	private handleAssistantMessage(content: string): void {
		if (!content.startsWith('{')) {
			return;
		}
		try {
			const messageJson = JSON.parse(content) as JsonObject;
			const previousRaw = this.currentAssistantMessage?.raw != null ? (this.currentAssistantMessage.raw as JsonObject) : null;
			const previousAssistantContent = this.assistantContent;
			const previousThinkingContent = ReplayDeduplicator.extractThinkingContent(previousRaw);
			const mergedRaw = this.messageMerger.mergeAssistantMessage(previousRaw, messageJson);

			if (this.currentAssistantMessage == null) {
				this.currentAssistantMessage = createMessage(MessageType.ASSISTANT, '', mergedRaw);
				this.state.addMessage(this.currentAssistantMessage!);
			} else {
				this.currentAssistantMessage!.raw = mergedRaw;
			}

			const aggregatedText = this.messageParser.extractMessageContent(mergedRaw);
			const streamingText = ReplayDeduplicator.extractTextContent(mergedRaw);
			if (!this.isStreaming) {
				this.assistantContent = '';
				if (aggregatedText) {
					this.assistantContent = aggregatedText;
				}
				this.currentAssistantMessage!.content = this.assistantContent;
				this.replayDedup.reset();
			} else if (streamingText.length > this.assistantContent.length) {
				// 保守同步：全量文本更长时更新累加器，防止 delta 丢失。
				this.assistantContent = streamingText;
				this.currentAssistantMessage!.content = this.assistantContent;
				this.replayDedup.beginContentReplay(
					streamingText,
					ReplayDeduplicator.replayOffset(previousAssistantContent.length, this.replayDedup.contentOffset()),
				);
			}
			this.currentAssistantMessage!.raw = mergedRaw;

			if (this.isStreaming) {
				const mergedThinkingContent = ReplayDeduplicator.extractThinkingContent(mergedRaw);
				if (mergedThinkingContent.length > previousThinkingContent.length) {
					this.replayDedup.beginThinkingReplay(
						mergedThinkingContent,
						ReplayDeduplicator.replayOffset(previousThinkingContent.length, this.replayDedup.thinkingOffset()),
					);
				}
				const seg = ReplayDeduplicator.syncSegmentActivity(mergedRaw);
				this.textSegmentActive = seg.textActive;
				this.thinkingSegmentActive = seg.thinkingActive;
			}

			const hasToolUse = this.messageHasToolUse(mergedRaw);
			if (hasToolUse) {
				const toolSeg = ReplayDeduplicator.syncSegmentActivity(mergedRaw);
				this.textSegmentActive = toolSeg.textActive;
				this.thinkingSegmentActive = toolSeg.thinkingActive;
				// Log tool_use blocks in the assistant message
				const messageObjTU = getObj(mergedRaw, 'message');
				const contentArrTU = getObjArray(messageObjTU, 'content');
				if (contentArrTU) {
					for (const el of contentArrTU) {
						if (isObject(el)) {
							const b = el as JsonObject;
							if (getString(b, 'type') === 'tool_use') {
								const inp = (b.input ?? {}) as JsonObject;
								const inputKeys = inp ? Object.keys(inp) : [];
								console.log(`[MessageHandler] assistant tool_use: name="${getString(b, 'name')}" id="${getString(b, 'id')}" inputKeys=[${inputKeys}] inputPreview=${JSON.stringify(inp).substring(0, 400)}`);
							}
						}
					}
				}
			}

			// 结构化变化（tool_use/thinking 块、分段边界）必须推给前端。
			this.callbackHandler.notifyMessageUpdate(this.state.getMessages());

			// assistant 消息的 usage 是权威终值，流式与非流式都必须更新。
			const messageObj = getObj(mergedRaw, 'message');
			const usage = getObj(messageObj, 'usage');
			if (usage) {
				const usedTokens = extractContextTokens(usage, this.state.getProvider());
				const maxTokens = getModelContextLimit(this.state.getModel());
				this.callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
			}
		} catch {
			// 解析失败忽略
		}
	}

	private messageHasToolUse(raw: JsonObject | null): boolean {
		if (!raw) {
			return false;
		}
		const message = getObj(raw, 'message');
		const contentArray = getObjArray(message, 'content');
		if (!contentArray) {
			return false;
		}
		for (const element of contentArray) {
			if (isObject(element)) {
				const block = element as JsonObject;
				if (getString(block, 'type') === 'tool_use') {
					return true;
				}
			}
		}
		return false;
	}

	private handleThinkingMessage(): void {
		if (!this.isThinking) {
			this.isThinking = true;
			this.callbackHandler.notifyThinkingStatusChanged(true);
		}
	}

	private handleContent(content: string): void {
		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}

		this.assistantContent += content;

		if (this.currentAssistantMessage == null) {
			this.currentAssistantMessage = createMessage(MessageType.ASSISTANT, this.assistantContent);
			this.state.addMessage(this.currentAssistantMessage!);
		} else {
			this.currentAssistantMessage.content = this.assistantContent;
		}

		if (!this.isStreaming) {
			this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		}
	}

	private handleContentDelta(content: string): void {
		if (!content) {
			return;
		}
		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}

		this.thinkingSegmentActive = false;

		const novelContent = this.replayDedup.consumeContentDelta(content);
		if (!novelContent) {
			return;
		}

		this.assistantContent += novelContent;
		this.ensureCurrentAssistantMessageExists();
		this.currentAssistantMessage!.content = this.assistantContent;
		this.applyTextDeltaToRaw(novelContent);
		this.textSegmentActive = true;

		this.callbackHandler.notifyContentDelta(novelContent);
		console.log('[MessageHandler] handleContentDelta calling notifyMessageUpdate, messages count:', this.state.getMessages().length);
		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
	}

	private handleSessionId(content: string): void {
		this.state.setSessionId(content);
		this.callbackHandler.notifySessionIdReceived(content);
	}

	private handleUserMessage(content: string): void {
		if (!content.startsWith('{')) {
			return;
		}
		try {
			const userMsg = JSON.parse(content) as JsonObject;

			if (this.messageParser.hasToolResult(userMsg)) {
				const toolResultMessage = createMessage(MessageType.USER, '[tool_result]', userMsg);
				this.state.addMessage(toolResultMessage);
				this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
				return;
			}

			const uuid = getString(userMsg, 'uuid');
			if (uuid == null) {
				return;
			}

			const userText = this.messageParser.extractMessageContent(userMsg);
			if (!userText) {
				return;
			}

			// 找到最新未解析且文本匹配的 user 消息，打上 uuid。
			const messages = this.state.getMessagesReference();
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg.type !== MessageType.USER || userText !== msg.content) {
					continue;
				}
				if (!isObject(msg.raw)) {
					msg.raw = {};
				}
				const raw = msg.raw as JsonObject;
				if (raw.uuid != null && !(raw.uuid === null)) {
					continue;
				}
				raw.uuid = uuid;
				this.callbackHandler.notifyUserMessageUuidPatched(msg.content ?? '', uuid);
				break;
			}
		} catch {
			// 解析失败忽略
		}
	}

	private handleToolResult(content: string): void {
		if (!content.startsWith('{')) {
			return;
		}
		try {
			const toolResultBlock = JSON.parse(content) as JsonObject;
			const toolUseId = getString(toolResultBlock, 'tool_use_id');
			if (toolUseId != null) {
				const rawUser: JsonObject = {
					type: 'user',
					message: { content: [toolResultBlock] },
				};
				const toolResultMessage = createMessage(MessageType.USER, '[tool_result]', rawUser);
				this.state.addMessage(toolResultMessage);
				this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
			}
		} catch {
			// 解析失败忽略
		}
	}

	private handleMessageEnd(): void {
		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}
		// 状态清理统一交给 onStreamEnd（流式）/ onComplete（非流式）。
	}

	private handleResult(content: string): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const resultJson = JSON.parse(content) as JsonObject;
			const usage = getObj(resultJson, 'usage');
			if (usage && this.currentAssistantMessage?.raw != null) {
				const raw = this.currentAssistantMessage.raw as JsonObject;
				raw.turnUsage = structuredClone(usage);

				const message = getObj(raw, 'message');
				const hasExistingUsage = getObj(message, 'usage') != null;
				if (!hasExistingUsage && message) {
					message.usage = usage;
					const usedTokens = extractContextTokens(usage, this.state.getProvider());
					const maxTokens = getModelContextLimit(this.state.getModel());
					this.callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
				}
				this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
			}
		} catch {
			// 解析失败忽略
		}
	}

	private handleSlashCommands(content: string): void {
		try {
			const commandsArray = JSON.parse(content) as unknown[];
			const commands: string[] = [];
			for (const c of commandsArray) {
				if (typeof c === 'string') {
					commands.push(c);
				}
			}
			this.state.setSlashCommands(commands);
			this.callbackHandler.notifySlashCommandsReceived(commands);
		} catch {
			// 解析失败忽略
		}
	}

	private handleSystemMessage(content: string): void {
		try {
			const systemObj = JSON.parse(content) as JsonObject | null;
			if (!isObject(systemObj)) {
				return;
			}
			const subtype = getString(systemObj, 'subtype');
			if (subtype != null && subtype.startsWith('task_')) {
				this.callbackHandler.notifyTaskEvent(content);
				return;
			}

			const commandsArray = getObjArray(systemObj, 'slash_commands');
			if (commandsArray) {
				const commands: string[] = [];
				for (const c of commandsArray) {
					if (typeof c === 'string') {
						commands.push(c);
					}
				}
				this.state.setSlashCommands(commands);
				this.callbackHandler.notifySlashCommandsReceived(commands);
			}
		} catch {
			// 解析失败忽略
		}
	}

	// =========================================================================
	// 流式处理
	// =========================================================================

	private handleStreamStart(): void {
		this.isStreaming = true;
		this.streamEndedThisTurn = false;
		this.errorReportedThisTurn = false;
		this.lastReportedError = null;
		this.resetTurnState();
		this.callbackHandler.notifyStreamStart();
	}

	private handleStreamEnd(): void {
		this.isStreaming = false;
		this.streamEndedThisTurn = true;
		this.resetSegmentState();

		if (this.isThinking) {
			this.isThinking = false;
			this.callbackHandler.notifyThinkingStatusChanged(false);
		}

		this.ensureRawBlocksConsistency();

		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		this.callbackHandler.notifyStreamEnd();
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.updateLastModifiedTime();
		this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
	}

	private handleBlockReset(): void {
		this.resetSegmentState();
		this.callbackHandler.notifyBlockReset();
	}

	private handleThinkingDelta(content: string): void {
		if (!content) {
			return;
		}
		if (!this.isThinking) {
			this.isThinking = true;
			this.callbackHandler.notifyThinkingStatusChanged(true);
		}
		this.ensureCurrentAssistantMessageExists();
		const novelContent = this.replayDedup.consumeThinkingDelta(content);
		if (!novelContent) {
			return;
		}
		const applied = this.applyThinkingDeltaToRaw(novelContent);
		if (applied) {
			this.thinkingSegmentActive = true;
			// 仅在实际应用 delta 时通知前端 —— 前端无去重，会累加导致重复。
			this.callbackHandler.notifyThinkingDelta(novelContent);
			this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		}
	}

	private ensureCurrentAssistantMessageExists(): void {
		if (this.currentAssistantMessage == null) {
			const raw: JsonObject = { type: 'assistant', message: { content: [] } };
			this.currentAssistantMessage = createMessage(MessageType.ASSISTANT, '', raw);
			this.state.addMessage(this.currentAssistantMessage!);
		}
		if (!isObject(this.currentAssistantMessage.raw)) {
			this.currentAssistantMessage.raw = { type: 'assistant', message: { content: [] } };
		}
	}

	private ensureAssistantContentArray(): JsonArray {
		this.ensureCurrentAssistantMessageExists();
		const raw = this.currentAssistantMessage!.raw as JsonObject;
		let message = getObj(raw, 'message');
		if (!message) {
			message = {};
			raw.message = message;
		}
		let content = getObjArray(message, 'content');
		if (!content) {
			content = [];
			message.content = content;
		}
		return content;
	}

	private applyTextDeltaToRaw(delta: string): boolean {
		if (!delta) {
			return false;
		}
		const contentArray = this.ensureAssistantContentArray();
		let target: JsonObject | null = null;

		if (this.textSegmentActive) {
			for (let i = contentArray.length - 1; i >= 0; i--) {
				const element = contentArray[i];
				if (isObject(element)) {
					const block = element as JsonObject;
					if (getString(block, 'type') === 'text') {
						target = block;
						break;
					}
				}
			}
		}

		if (target == null) {
			target = { type: 'text', text: '' };
			contentArray.push(target);
		}

		const existing = typeof target.text === 'string' ? target.text : '';
		target.text = existing + delta;
		return true;
	}

	private applyThinkingDeltaToRaw(delta: string): boolean {
		if (!delta) {
			return false;
		}
		const contentArray = this.ensureAssistantContentArray();
		let target: JsonObject | null = null;

		if (this.thinkingSegmentActive) {
			for (let i = contentArray.length - 1; i >= 0; i--) {
				const element = contentArray[i];
				if (isObject(element)) {
					const block = element as JsonObject;
					if (getString(block, 'type') === 'thinking') {
						target = block;
						break;
					}
				}
			}
		}

		if (target == null) {
			target = { type: 'thinking', thinking: '' };
			contentArray.push(target);
		}

		const existing = typeof target.thinking === 'string' ? target.thinking : '';
		target.thinking = existing + delta;
		return true;
	}

	/**
	 * 保证 raw 文本块与累加的 assistantContent 一致（保守同步可能让最后
	 * 一个文本块短于实际流式内容）。仅修正文本块——thinking 无独立累加器。
	 */
	private ensureRawBlocksConsistency(): void {
		if (this.currentAssistantMessage?.raw == null || !isObject(this.currentAssistantMessage.raw)) {
			return;
		}
		const raw = this.currentAssistantMessage.raw as JsonObject;
		const message = getObj(raw, 'message');
		const contentArray = getObjArray(message, 'content');
		if (!contentArray) {
			return;
		}

		const accumulatedText = this.assistantContent;
		if (!accumulatedText) {
			return;
		}

		let lastTextBlock: JsonObject | null = null;
		let precedingTextLength = 0;
		for (const element of contentArray) {
			if (!isObject(element)) {
				continue;
			}
			const block = element as JsonObject;
			if (getString(block, 'type') === 'text') {
				lastTextBlock = block;
				precedingTextLength += typeof block.text === 'string' ? block.text.length : 0;
			}
		}

		if (lastTextBlock != null) {
			const lastBlockText = typeof lastTextBlock.text === 'string' ? lastTextBlock.text : '';
			precedingTextLength -= lastBlockText.length;

			if (accumulatedText.length < precedingTextLength) {
				// 累加器与 raw 块漂移，输出告警而非静默产生空尾部。
				console.warn(
					`[MessageHandler] accumulatedText (${accumulatedText.length}) shorter than precedingTextLength (${precedingTextLength})`,
				);
				return;
			}

			const expectedLastBlockText = accumulatedText.substring(precedingTextLength);
			if (lastBlockText.length < expectedLastBlockText.length) {
				lastTextBlock.text = expectedLastBlockText;
			}
		}
	}

	private handleUsage(content: string): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const usageJson = JSON.parse(content) as JsonObject;
			const usedTokens = extractContextTokens(usageJson, this.state.getProvider());
			const maxTokens = getModelContextLimit(this.state.getModel());
			this.callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
			this.ensureCurrentAssistantMessageExists();
			this.backfillUsageToAssistantMessage(usageJson);
		} catch {
			// 解析失败忽略
		}
	}

	private handleRevertState(content: string): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const payload = JSON.parse(content) as { hasRevert: boolean };
			if (payload.hasRevert) {
				this.state.setRevertState({ messageID: '' });
			} else {
				this.state.setRevertState(null);
			}
			// 同步给 webview：发送消息后服务端 revert.cleanup 会清除指针，
			// webview 据此撤掉撤销占位条（App 侧仅在状态变化时重载，不会成环）。
			this.callbackHandler.notifyRevertStateUpdate(payload.hasRevert);
			this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
		} catch {
			// 解析失败忽略
		}
	}

	/**
	 * 处理 [PERMISSION_REQUEST] / [QUESTION_REQUEST]（opencode 弹层）。
	 * 把 daemon 归一化的 JSON 转成 PermissionRequest 转发给前端。
	 * daemon 已把 v1/v2 事件统一成 `{type, sessionId, permissionId|requestId,
	 * tool, description, questions}` 的规范形。
	 */
	private handlePermissionRequest(content: string, isQuestion = false): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const payload = JSON.parse(content) as JsonObject;
			const toolNameRaw = payload.tool;
		const toolName = typeof toolNameRaw === 'string' ? toolNameRaw : '';
		logDiagnostic(`[MessageHandler] handlePermissionRequest isQuestion=${isQuestion} toolNameRaw=${JSON.stringify(toolNameRaw)} toolName="${toolName}" toolNameType=${typeof toolNameRaw} payloadKeys=${Object.keys(payload)}`);
		const request = {
			type: isQuestion ? 'question' : typeof payload.type === 'string' ? payload.type : 'permission',
			toolUseId:
				(typeof payload.tool_use_id === 'string' && payload.tool_use_id) ||
				// Permission requests carry the originating call id as the
				// camelCase `toolUseId`; accept both spellings.
				(typeof payload.toolUseId === 'string' && payload.toolUseId) ||
				(typeof payload.permissionId === 'string' && (payload.permissionId as string)) ||
				'',
			toolName,
			description:
				(typeof payload.description === 'string' && payload.description) ||
				(typeof payload.message === 'string' && (payload.message as string)) ||
				'',
			sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
			requestId:
				(typeof payload.requestId === 'string' && payload.requestId) ||
				(typeof payload.permissionId === 'string' && (payload.permissionId as string)) ||
				undefined,
			questions: Array.isArray(payload.questions) ? (payload.questions as Array<Record<string, unknown>>) : undefined,
		};
		logDiagnostic(`[MessageHandler] handlePermissionRequest resolved: type=${request.type} toolUseId="${request.toolUseId}" toolName="${request.toolName}" requestId=${request.requestId}`);
			this.callbackHandler.notifyPermissionRequested(request);
		} catch {
			// 解析失败忽略
		}
	}

	/** 把 usage 回填到当前 assistant 消息的 raw。流式期间总是更新以累积。 */
	private backfillUsageToAssistantMessage(usageJson: JsonObject): void {
		const current = this.currentAssistantMessage;
		if (current?.raw == null || !isObject(current.raw)) {
			return;
		}
		const raw = current.raw as JsonObject;
		const message = getObj(raw, 'message');
		if (!message) {
			return;
		}
		message.usage = usageJson;
	}
}
