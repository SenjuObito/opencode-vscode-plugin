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
			case 'message_removed':
				this.handleMessageRemoved(content);
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
		case 'session_title':
			this.handleSessionTitle(content);
			break;
		case 'retry_status':
			this.handleRetryStatus(content);
			break;
		case 'turn_error':
			this.handleTurnError(content);
			break;
		case 'turn_end':
			this.handleTurnEnd(content);
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

		// 与 idea 的 OpenCodeMessageHandler.onError 一致：改写尾部错误行而不是
		// 追加。同一回合里「本地超时」+「服务端真实原因」是同一个失败的两种表述，
		// 两条 ERROR 气泡会被读成失败两次。
		this.state.replaceLastErrorMessage(error);

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
			this.finalizeTurnDuration();
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
		this.finalizeTurnDuration();

		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		this.callbackHandler.notifyStreamEnd();
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.updateLastModifiedTime();
		this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
	}

	/**
	 * 权威结算本次 Turn 耗时并写入 Assistant 消息实体（以及 raw.durationMs）。
	 */
	private finalizeTurnDuration(): void {
		const turnStartTime = this.state.getActiveTurnStartTime();
		if (turnStartTime) {
			const durationMs = Math.max(0, Date.now() - turnStartTime);
			const targetAssistantMsg = this.currentAssistantMessage || this.findLastAssistantMessage();
			if (targetAssistantMsg) {
				if (targetAssistantMsg.durationMs === undefined) {
					targetAssistantMsg.durationMs = durationMs;
				}
				if (targetAssistantMsg.raw && typeof targetAssistantMsg.raw === 'object') {
					const rawObj = targetAssistantMsg.raw as Record<string, unknown>;
					if (rawObj.durationMs === undefined) {
						rawObj.durationMs = durationMs;
					}
				}
			}
		}
	}

	private findLastAssistantMessage(): ChatMessage | undefined {
		const messages = this.state.getMessages();
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].type === MessageType.ASSISTANT) {
				return messages[i];
			}
		}
		return undefined;
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
			this.attachTurnUsageToAssistantMessage(usageJson);
		} catch {
			// 解析失败忽略
		}
	}

	private handleRevertState(content: string): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const payload = JSON.parse(content) as { hasRevert?: boolean; messageId?: string | null };
			const hasRevert = payload.hasRevert === true;
			// 边界消息 id：webview 据此把转录切在正确的用户消息上。缺失时占位条会退回
			// 「最后一条 user 消息」的兜底，边界不是末条 user 时切片位置就会偏后。
			const messageId = typeof payload.messageId === 'string' && payload.messageId ? payload.messageId : '';
			if (hasRevert) {
				this.state.setRevertState({ messageID: messageId });
			} else {
				this.state.setRevertState(null);
			}
			// 同步给 webview：发送消息后服务端 revert.cleanup 会清除指针，
			// webview 据此撤掉撤销占位条（App 侧仅在状态变化时重载，不会成环）。
			this.callbackHandler.notifyRevertStateUpdate(hasRevert, messageId || null);
			this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
		} catch {
			// 解析失败忽略
		}
	}

	/**
	 * 处理服务端权威删除（opencode 在下一次 prompt 开始时执行 revert cleanup，
	 * 逐条广播 message.removed）。
	 *
	 * opencode 的 revert 只写一个「此处往后作废」的指针，真正的删除发生在下一次
	 * prompt：服务端先跑 cleanup 把 revert 点之后的消息删掉，再落新的用户消息。
	 * 宿主必须跟着删，否则它会一直揣着已作废的消息，继续发消息时又把这些内容推回
	 * webview —— 也就是「撤回的消息复活」。
	 */
	private handleMessageRemoved(content: string): void {
		if (!content || !content.startsWith('{')) {
			return;
		}
		try {
			const payload = JSON.parse(content) as { sessionID?: string; messageID?: string };
			// daemon 流按目录作用域，同一目录下的兄弟会话删除不能动当前会话。
			const sessionId = payload.sessionID;
			const currentSessionId = this.state.getSessionId();
			if (sessionId && currentSessionId && sessionId !== currentSessionId) {
				logDiagnostic(`[MessageHandler] Ignoring message_removed for another session: ${sessionId}`);
				return;
			}
			const messageId = payload.messageID;
			if (!messageId) {
				return;
			}
			if (!this.state.removeMessagesByIds([messageId])) {
				// 已被发送前的边界裁剪处理过 —— 权威事件只是确认，无需再推。
				return;
			}
			logDiagnostic(`[MessageHandler] Removed reverted message from session state: ${messageId}`);
			// 顺序重要：先让 webview 剔除，再推（已经变短的）快照。提前剔除使 webview 的
			// 列表长度与快照同步，其「收缩保护」才不会把作废的尾部抢救回来。
			this.callbackHandler.notifyMessagesRemoved([messageId]);
			this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
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
			directory: typeof payload.directory === 'string' ? payload.directory : undefined,
			questions: Array.isArray(payload.questions) ? (payload.questions as Array<Record<string, unknown>>) : undefined,
		};
		logDiagnostic(`[MessageHandler] handlePermissionRequest resolved: type=${request.type} toolUseId="${request.toolUseId}" toolName="${request.toolName}" requestId=${request.requestId} directory=${request.directory}`);
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

	/** 挂载规范化的 turnUsage 与 turnCostUsd 到当前 assistant 消息，供前端详细输出展示。 */
	private attachTurnUsageToAssistantMessage(usageJson: JsonObject): void {
		const current = this.currentAssistantMessage;
		if (!current) {
			return;
		}
		if (current.raw == null || !isObject(current.raw)) {
			current.raw = {};
		}
		const raw = current.raw as JsonObject;
		const input = typeof usageJson.input_tokens === 'number' ? usageJson.input_tokens : 0;
		const output = typeof usageJson.output_tokens === 'number' ? usageJson.output_tokens : 0;
		const reasoning = typeof usageJson.reasoning_tokens === 'number' ? usageJson.reasoning_tokens : 0;
		const cacheRead = typeof usageJson.cache_read_input_tokens === 'number'
			? usageJson.cache_read_input_tokens
			: typeof usageJson.cache_read === 'number'
				? usageJson.cache_read
				: 0;
		const cacheCreation = typeof usageJson.cache_creation_input_tokens === 'number'
			? usageJson.cache_creation_input_tokens
			: typeof usageJson.cache_creation === 'number'
				? usageJson.cache_creation
				: 0;

		const turnUsage: JsonObject = {
			input_tokens: input,
			cache_creation_input_tokens: cacheCreation,
			cache_read_input_tokens: cacheRead,
			output_tokens: output + reasoning,
			reasoning_tokens: reasoning,
			total_tokens: input + cacheCreation + cacheRead + output + reasoning,
		};
		raw.turnUsage = turnUsage;

		if (typeof usageJson.cost === 'number' && Number.isFinite(usageJson.cost) && usageJson.cost > 0) {
			raw.turnCostUsd = usageJson.cost;
		}

		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
	}

	private handleSessionTitle(content: string): void {
		if (!content || content.trim() === '') {
			return;
		}
		try {
			const obj = JSON.parse(content);
			const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null;
			const title = typeof obj.title === 'string' ? obj.title : null;
			if (sessionId && title) {
				logDiagnostic(`[MessageHandler] handleSessionTitle sessionId=${sessionId} title=${title}`);
				this.callbackHandler.notifySessionTitleReceived(sessionId, title);
			}
		} catch (err) {
			logDiagnostic(`[MessageHandler] handleSessionTitle parse error: ${err}`);
		}
	}

	/**
	 * 服务端限流／额度重试状态。
	 *
	 * 这是解释「回合为什么卡了几分钟」的唯一权威信号：opencode 因为在退避重试
	 * （免费额度／账号配额耗尽），payload 的 action 里带着人话原因和订阅／配额
	 * 页链接。直接透传给 webview 渲染常驻提示条。
	 */
	private handleRetryStatus(payload: string): void {
		if (!payload || payload.trim() === '') {
			return;
		}
		logDiagnostic(`[MessageHandler] retry_status payload=${payload.substring(0, 300)}`);
		this.callbackHandler.notifyRetryStatus(payload);
	}

	/**
	 * 本地 180s 超时之后才到达的服务端真实失败原因。
	 *
	 * daemon 的兜底超时会先删掉 active turn，于是服务端迟到的 session.error
	 * 已经没有 turn 可结算；此前它被误投到压缩结果通道（只打一行 log 就丢），
	 * 真实原因被二次掩埋。这里把它作为对泛化超时文案的修正渲染出来：
	 * 若末尾已有 ERROR 行就改写它，避免同一回合出现两条错误气泡。
	 */
	private handleTurnError(content: string): void {
		if (!content || content.trim() === '') {
			return;
		}
		let message = content;
		try {
			const obj = JSON.parse(content) as { message?: unknown };
			if (typeof obj.message === 'string' && obj.message.trim() !== '') {
				message = obj.message;
			}
		} catch {
			// 非 JSON 对象：整体当作错误文案。
		}

		logDiagnostic(`[MessageHandler] turn_error (late): ${message.substring(0, 300)}`);
		this.state.setError(message);
		this.state.setBusy(false);
		this.state.setLoading(false);
		this.state.replaceLastErrorMessage(message);
		this.callbackHandler.notifyStreamEnd();
		this.callbackHandler.notifyMessageUpdate(this.state.getMessages());
		this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(), this.state.getError());
	}

	/**
	 * daemon 的权威回合终止（`[TURN_END] {sessionId, reason, turnId}`）。
	 *
	 * 与 idea 的 `OpenCodeMessageHandler.handleTurnEnd` 同语义：按 sessionId
	 * 过滤（目录级事件流会夹带兄弟会话的终止），结束本回合的流式状态，
	 * 然后投递 `turn.settled`。它是「停止后 loading 不归零」与「迟到错误
	 * 泄漏」两条链路的唯一收口点。
	 *
	 * 与 `[STREAM_END]` 的关系：正常情况下 STREAM_END 先到（已收尾一次），
	 * 这里只补一次幂等的状态通知；若 STREAM_END 因中断/断线没到，这里按同一
	 * 收尾语义补齐，避免 UI 永远停在 streaming。
	 */
	private handleTurnEnd(content: string): void {
		if (!content || content.trim() === '') {
			return;
		}

		let sessionId: string | null = null;
		let reason: string | null = null;
		try {
			const obj = JSON.parse(content) as { sessionId?: unknown; sessionID?: unknown; reason?: unknown };
			const rawId = typeof obj.sessionId === 'string' ? obj.sessionId : obj.sessionID;
			sessionId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : null;
			reason = typeof obj.reason === 'string' ? obj.reason : null;
		} catch {
			// 非 JSON：仍按「本会话回合结束」处理，宁多收尾不漏收尾。
		}

		const ownSessionId = this.state.getSessionId();
		if (sessionId && ownSessionId && sessionId !== ownSessionId) {
			logDiagnostic(
				`[MessageHandler] ignoring turn_end for another session: ${sessionId} (own=${ownSessionId})`,
			);
			return;
		}

		logDiagnostic(`[MessageHandler] turn_end session=${sessionId ?? '(own)'} reason=${reason ?? 'unknown'}`);

		if (!this.streamEndedThisTurn) {
			// STREAM_END 没到：按同一语义补齐收尾（含 notifyStreamEnd）。
			this.handleStreamEnd();
		} else {
			this.state.setBusy(false);
			this.state.setLoading(false);
			this.state.updateLastModifiedTime();
			this.callbackHandler.notifyStateChange(
				this.state.isBusy(),
				this.state.isLoading(),
				this.state.getError(),
			);
		}

		this.callbackHandler.notifyTurnEnd(content);
	}
}
