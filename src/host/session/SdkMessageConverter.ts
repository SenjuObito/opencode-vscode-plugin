/**
 * SdkMessageConverter — converts opencode SDK session message entries
 * (`[{ info, parts }]`, as returned by `session.messages`) into the host's
 * cc-gui-shaped ChatMessage[] so a session can be restored into the webview.
 *
 * SDK part shapes (from @opencode-ai/sdk v2 types):
 *   text      → { type:'text', text }
 *   reasoning → { type:'reasoning', text }          → cc-gui thinking block
 *   tool      → { type:'tool', callID, tool, state:{ status, input, output } }
 *   file      → { type:'file', mime, filename?, url }
 *
 * Restore mirrors the streaming shape (MessageHandler): assistant messages carry
 * text/thinking/tool_use blocks; tool outputs become separate `[tool_result]`
 * user messages appended after the assistant message that ran the tool.
 */
import { ChatMessage, MessageType } from './types';
import { createMessage } from './SessionState';
import { sanitizeUserText } from './UserTextSanitizer';

export interface SdkPart {
	id?: string;
	type: string;
	text?: string;
	callID?: string;
	tool?: string;
	mime?: string;
	filename?: string;
	url?: string;
	state?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface SdkMessageInfo {
	id?: string;
	role?: string;
	time?: { start?: number; end?: number; created?: number; completed?: number };
	model?: string;
	tokens?: Record<string, unknown>;
	cost?: number;
	[key: string]: unknown;
}

export interface SdkMessageEntry {
	info?: SdkMessageInfo;
	parts?: SdkPart[];
}

/** 把一个 SDK 消息条目转换成 0..N 条宿主 ChatMessage（assistant 的 tool 输出拆成 tool_result 用户消息）。 */
export function convertSdkMessage(entry: SdkMessageEntry): ChatMessage[] {
	const info = entry?.info ?? {};
	const parts = Array.isArray(entry?.parts) ? entry.parts : [];
	const role = typeof info.role === 'string' ? info.role : '';

	// SDK time 是 epoch 毫秒；缺省用当前时间（恢复显示无强时序要求）。
	const created =
		typeof info.time?.created === 'number' && info.time.created > 0
			? info.time.created
			: typeof info.time?.start === 'number' && info.time.start > 0
				? info.time.start
				: Date.now();
	const timestamp = created;

	if (role === 'user') {
		return [buildUserMessage(parts, info, timestamp)];
	}

	if (role === 'compaction' || info.isCompactSummary === true || info.type === 'compaction') {
		const message = buildCompactionMessage(parts, info, timestamp);
		return message ? [message] : [];
	}

	if (role === 'assistant') {
		return buildAssistantMessages(parts, info, timestamp);
	}

	return []; // system / 其他 role 跳过
}

/**
 * 一条持久化的压缩记录 → 转录里的 compaction 消息。
 *
 * <p>摘要进 `content`（raw 只放身份），状态与失败原因进 `compaction`：
 * 历史行与实时卡因此共用同一个渲染器，不再有“历史摘要被整条丢弃”或
 * “失败压缩显示成空摘要”的分叉。</p>
 */
function buildCompactionMessage(
	parts: SdkPart[],
	info: SdkMessageInfo,
	timestamp: number,
): ChatMessage | null {
	const summary = parts
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => String(part.text))
		.join('\n');
	const rawStatus = typeof info.compactionStatus === 'string'
		? info.compactionStatus
		: (typeof info.status === 'string' ? info.status : 'completed');
	const status: 'in_progress' | 'completed' | 'failed' =
		rawStatus === 'failed'
			? 'failed'
			: (rawStatus === 'running' || rawStatus === 'in_progress' ? 'in_progress' : 'completed');
	// A failed compaction did not replace the context: it is operational
	// feedback, not a transcript boundary. The live card shows it once; the
	// reloaded history must not replay a wall of "Nothing to compact yet".
	if (status === 'failed') {
		return null;
	}
	const reason = typeof info.compactionReason === 'string'
		? info.compactionReason
		: (typeof info.reason === 'string' ? info.reason : 'auto');
	const raw: Record<string, unknown> = { type: 'compaction' };
	if (typeof info.id === 'string' && info.id) {
		raw.id = info.id;
		raw.uuid = info.id;
	}
	const tokens = info.tokens && typeof info.tokens === 'object'
		? info.tokens as Record<string, unknown>
		: undefined;
	const error = compactionErrorMessage(info.error);
	return {
		type: MessageType.COMPACTION,
		content: summary,
		timestamp,
		raw,
		compaction: {
			status,
			reason,
			startedAt: timestamp,
			...(status === 'completed' ? { completedAt: timestamp } : {}),
			...(tokens ? { tokens } : {}),
			...(error ? { error } : {}),
		},
	};
}

function compactionErrorMessage(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (value && typeof value === 'object') {
		const message = (value as Record<string, unknown>).message;
		if (typeof message === 'string' && message.trim()) {
			return message;
		}
	}
	return undefined;
}

export function convertSdkMessages(entries: SdkMessageEntry[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		out.push(...convertSdkMessage(entry));
	}

	// 领域模型约束：清理中间过程消息上的误导性局部耗时。
	// 若一条 assistant 消息紧随其后的是 [tool_result]，说明它仅发起了工具调用，
	// 属于交互回合（Turn）的中间步骤，绝非该回合的最终结算，不应携带 durationMs。
	for (let i = 0; i < out.length; i++) {
		const msg = out[i];
		if (msg.type === MessageType.ASSISTANT) {
			const nextMsg = out[i + 1];
			const isFollowedByToolResult =
				nextMsg && nextMsg.type === MessageType.USER && nextMsg.content === '[tool_result]';
			if (isFollowedByToolResult) {
				if (msg.raw && typeof msg.raw === 'object') {
					delete (msg.raw as Record<string, unknown>).durationMs;
				}
				delete (msg as any).durationMs;
			}
		}
	}

	return out;
}

/**
 * Extract a single subagent's transcript from an already-converted parent
 * session message list.
 *
 * OpenCode persists each subagent sidechain as a real child session (a session
 * row with a non-empty `parentID`), but it also mirrors the invocation and
 * result inside the parent transcript as a `tool_use` block (id === toolUseId,
 * for the task/subagent tool) followed by its `tool_result`. Core keeps those
 * child sessions out of the history list; this walks the parent transcript so a
 * subagent block can be opened without an extra child-session round trip.
 *
 * @returns the raw messages (ClaudeRawMessage shape, ready for `messages[]`)
 *   plus the recovered result text, or empty arrays when the subagent is not
 *   present yet (still running or opencode did not surface it).
 */
export interface SubagentTranscript {
	messages: unknown[];
	resultText?: string;
}

export function extractSubagentTranscript(
	messages: ChatMessage[],
	toolUseId: string,
): SubagentTranscript {
	const result: SubagentTranscript = { messages: [] };
	if (!toolUseId) {
		return result;
	}

	let invocation: Record<string, unknown> | undefined;

	for (const msg of messages) {
		const raw = msg.raw && typeof msg.raw === 'object'
			? (msg.raw as Record<string, unknown>)
			: undefined;
		if (!raw) { continue; }
		const message = raw.message && typeof raw.message === 'object'
			? (raw.message as Record<string, unknown>)
			: undefined;
		const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
		for (const block of content) {
			if (!block || typeof block !== 'object') { continue; }
			const b = block as Record<string, unknown>;
			if (b.type === 'tool_use' && b.id === toolUseId) {
				invocation = raw;
			} else if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
				const text = extractTextFromToolResult(b);
				if (text) {
					result.resultText = text;
				}
			}
		}
	}

	if (invocation) {
		result.messages.push(invocation);
	}
	if (result.resultText) {
		result.messages.push({
			type: 'assistant',
			message: { content: [{ type: 'text', text: result.resultText }] },
		});
	}
	return result;
}

function extractTextFromToolResult(block: Record<string, unknown>): string | undefined {
	const content = block.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (typeof c === 'string') { return c; }
				if (c && typeof c === 'object') {
					const cc = c as Record<string, unknown>;
					if (typeof cc.text === 'string') { return cc.text; }
					if (typeof cc.content === 'string') { return cc.content; }
				}
				return '';
			})
			.filter(Boolean)
			.join('\n') || undefined;
	}
	if (typeof block.text === 'string') {
		return block.text;
	}
	return undefined;
}

// =========================================================================
// 用户消息
// =========================================================================

function buildUserMessage(
	parts: SdkPart[],
	info: SdkMessageInfo,
	timestamp: number,
): ChatMessage {
	const blocks: Array<Record<string, unknown>> = [];
	const attachmentBlocks: Array<Record<string, unknown>> = [];
	const imageBlocks: Array<Record<string, unknown>> = [];
	let text = '';
	for (const part of parts) {
		if (part.type === 'text' && typeof part.text === 'string') {
			if (part.synthetic === true) {
				continue;
			}
			text += part.text;
		} else if (part.type === 'file') {
			const mime = typeof part.mime === 'string' ? part.mime : '';
			const url = typeof part.url === 'string' ? part.url : '';
			let filename = typeof part.filename === 'string' ? part.filename : '';
			if (!filename && url) {
				filename = url.split('/').pop() || '';
			}
			if (mime.startsWith('image/') && url.startsWith('data:')) {
				imageBlocks.push({
					type: 'image',
					src: url,
					mediaType: mime,
				});
			} else {
				attachmentBlocks.push({
					type: 'attachment',
					fileName: filename || (typeof part.title === 'string' ? part.title : ''),
					mediaType: mime,
				});
			}
		}
	}

	// Extract inlined attachment blocks (<attachment filename="...">) from text
	// so they render as attachment chips in the UI when restored from history.
	const inlinedRegex = /<attachment\s+filename="([^"]+)"[^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = inlinedRegex.exec(text)) !== null) {
		const filename = match[1];
		if (!attachmentBlocks.some((b) => b.fileName === filename)) {
			attachmentBlocks.push({
				type: 'attachment',
				fileName: filename,
				mediaType: 'text/plain',
			});
		}
	}

	const displayText = sanitizeUserText(text);

	for (const block of attachmentBlocks) {
		blocks.push(block);
	}
	for (const block of imageBlocks) {
		blocks.push(block);
	}
	if (displayText) {
		blocks.push({ type: 'text', text: displayText });
	}

	const raw: Record<string, unknown> = {
		type: 'user',
		message: { content: blocks },
	};
	if (info.id) {
		raw.id = info.id;
	}
	return createMessage(MessageType.USER, displayText, raw, timestamp);
}

// =========================================================================
// 助手消息（+ 拆出的 tool_result 用户消息）
// =========================================================================

function buildAssistantMessages(
	parts: SdkPart[],
	info: SdkMessageInfo,
	timestamp: number,
): ChatMessage[] {
	const blocks: Array<Record<string, unknown>> = [];
	let text = '';
	const toolResults: ChatMessage[] = [];

	for (const part of parts) {
		if (part.type === 'text' && typeof part.text === 'string') {
			text += part.text;
			blocks.push({ type: 'text', text: part.text });
		} else if (part.type === 'reasoning' && typeof part.text === 'string') {
			blocks.push({ type: 'thinking', thinking: part.text });
		} else if (part.type === 'tool') {
			const state = isObject(part.state) ? (part.state as Record<string, unknown>) : {};
			const callID = typeof part.callID === 'string' ? part.callID : (part.id ?? '');
			const toolName = typeof part.tool === 'string' ? part.tool : '';
			blocks.push({
				type: 'tool_use',
				id: callID,
				name: toolName,
				input: isObject(state.input) ? (state.input as Record<string, unknown>) : {},
			});
			// 已完成/出错工具的输出 → 独立 [tool_result] 用户消息（与流式一致）。
			const output = state.output;
			const error = state.error;
			if (typeof output === 'string' || typeof error === 'string') {
				const callId = typeof part.callID === 'string' ? part.callID : (part.id ?? '');
				const content = typeof error === 'string' ? error : output;
				toolResults.push(
					createMessage(MessageType.USER, '[tool_result]', {
						type: 'user',
						message: {
							content: [{ type: 'tool_result', tool_use_id: callId, content }],
						},
					}, timestamp),
				);
			}
		}
	}

	const raw: Record<string, unknown> = {
		type: 'assistant',
		message: { content: blocks },
	};
	if (info.id) {
		raw.id = info.id;
	}
	if (typeof info.model === 'string') {
		raw.model = info.model;
	}
	if (typeof info.modelID === 'string') {
		raw.model = info.modelID;
	}
	const completed =
		typeof info.time?.completed === 'number' && info.time.completed > 0
			? info.time.completed
			: typeof info.time?.end === 'number' && info.time.end > 0
				? info.time.end
				: null;
	if (completed !== null && completed >= timestamp) {
		raw.durationMs = completed - timestamp;
	}
	if (isObject(info.tokens)) {
		raw.tokens = info.tokens;
		const t = info.tokens as Record<string, unknown>;
		const cache = isObject(t.cache) ? (t.cache as Record<string, unknown>) : {};
		const inputTokens = Number(t.input) || 0;
		const outputTokens = Number(t.output) || 0;
		const reasoningTokens = Number(t.reasoning) || 0;
		const cacheReadTokens = Number(cache.read) || 0;
		const cacheCreationTokens = Number(cache.write) || 0;
		const totalTokens =
			Number(t.total) || (inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheCreationTokens);
		const turnUsage: Record<string, unknown> = {
			input_tokens: inputTokens,
			output_tokens: outputTokens + reasoningTokens,
			reasoning_tokens: reasoningTokens,
			cache_read_input_tokens: cacheReadTokens,
			cache_creation_input_tokens: cacheCreationTokens,
			total_tokens: totalTokens,
		};
		raw.turnUsage = turnUsage;
		(raw.message as Record<string, unknown>).usage = turnUsage;
		if (typeof info.cost === 'number' && info.cost > 0) {
			raw.turnCostUsd = info.cost;
		}
	}

	const assistant = createMessage(MessageType.ASSISTANT, text, raw, timestamp);
	return [assistant, ...toolResults];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
