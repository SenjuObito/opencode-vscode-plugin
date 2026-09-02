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
	time?: { start?: number; end?: number };
	model?: string;
	tokens?: Record<string, unknown>;
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
	const timestamp =
		typeof info.time?.start === 'number' && info.time.start > 0 ? info.time.start : Date.now();

	if (role === 'user') {
		return [buildUserMessage(parts, info, timestamp)];
	}

	if (role === 'assistant') {
		return buildAssistantMessages(parts, info, timestamp);
	}

	return []; // system / 其他 role 跳过
}

export function convertSdkMessages(entries: SdkMessageEntry[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		out.push(...convertSdkMessage(entry));
	}
	return out;
}

/**
 * Extract a single subagent's transcript from an already-converted parent
 * session message list.
 *
 * OpenCode does NOT persist subagent sidechains as separate opencode sessions
 * (unlike Claude Code's ~/.claude/projects/…/subagents/*.jsonl). Instead the
 * subagent's invocation and result live inside the parent session as a
 * `tool_use` block (id === toolUseId, for the task/skill tool) followed by its
 * `tool_result`. This walks the converted messages, locates that tool_use, and
 * rebuilds the subagent's portion so it can be pushed to the webview as a
 * `SubagentHistoryResponse`.
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
	let text = '';
	for (const part of parts) {
		if (part.type === 'text' && typeof part.text === 'string') {
			text += part.text;
			blocks.push({ type: 'text', text: part.text });
		} else if (part.type === 'file') {
			blocks.push({
				type: 'attachment',
				fileName: part.filename ?? part.url ?? part.title ?? '',
				mediaType: typeof part.mime === 'string' ? part.mime : 'application/octet-stream',
			});
		}
	}
	const raw: Record<string, unknown> = {
		type: 'user',
		message: { content: blocks },
	};
	if (info.id) {
		raw.id = info.id;
	}
	return createMessage(MessageType.USER, text || '[用户消息]', raw, timestamp);
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
			console.log(`[SdkMessageConverter] tool part: tool="${toolName}" callID="${callID}" state.status=${state.status} state.input=${JSON.stringify(state.input ?? {}).substring(0, 200)}`);
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
	if (isObject(info.tokens)) {
		raw.tokens = info.tokens;
	}

	const assistant = createMessage(MessageType.ASSISTANT, text || '(空响应)', raw, timestamp);
	return [assistant, ...toolResults];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
