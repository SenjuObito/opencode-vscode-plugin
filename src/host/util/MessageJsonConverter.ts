/**
 * MessageJsonConverter — port of cc-gui `util/MessageJsonConverter.java`.
 * Converts session messages to the JSON shape the webview renders, with
 * error-content truncation and tool_result size limits.
 */
import { ChatMessage } from '../session/types';
import { isObject, getObj, getString, JsonObject, JsonArray } from '../session/jsonUtils';
import { extractContextTokens } from './TokenUsageUtils';
import { getModelContextLimit } from './ModelContextLimits';

const MAX_ERROR_CONTENT_CHARS = 1000;
const ERROR_CONTENT_PREFIXES = ['API Error', 'API error', 'Error:', 'Error '];
const MAX_TOOL_RESULT_CHARS = 20_000;

export function convertMessagesToJson(messages: ChatMessage[]): string {
	return JSON.stringify(messages.map(convertMessage));
}

function convertMessage(msg: ChatMessage): JsonObject {
	const msgObj: JsonObject = {
		type: msg.type,
		timestamp: msg.timestamp,
		content: truncateErrorContent(msg.content ?? ''),
	};
	if (msg.raw != null && isObject(msg.raw)) {
		msgObj.raw = truncateRawForTransport(msg.raw);
	}
	return msgObj;
}

export function truncateErrorContent(content: string | null | undefined): string {
	if (content == null || content.length <= MAX_ERROR_CONTENT_CHARS) {
		return content ?? '';
	}
	for (const prefix of ERROR_CONTENT_PREFIXES) {
		if (content.startsWith(prefix)) {
			return (
				content.substring(0, MAX_ERROR_CONTENT_CHARS) +
				`... [truncated, total ${content.length} chars]`
			);
		}
	}
	return content;
}

export function isErrorContent(content: string | null | undefined): boolean {
	if (content == null) {
		return false;
	}
	for (const prefix of ERROR_CONTENT_PREFIXES) {
		if (content.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

/** 截断超大的 raw JSON（tool_result / error 文本块）。 */
export function truncateRawForTransport(raw: JsonObject): JsonObject {
	const transport = buildTransportRaw(raw);
	const contentEl = findContentElement(transport);

	if (contentEl == null) {
		return transport;
	}

	if (typeof contentEl === 'string') {
		const s = contentEl;
		if (s.length > MAX_ERROR_CONTENT_CHARS && isErrorContent(s)) {
			const copied = structuredClone(transport);
			const truncated = truncateErrorContent(s);
			if (copied.content !== undefined) {
				copied.content = truncated;
			} else if (isObject(copied.message)) {
				(copied.message as JsonObject).content = truncated;
			}
			return copied;
		}
		return transport;
	}

	if (!Array.isArray(contentEl)) {
		return transport;
	}

	let needsCopy = false;
	for (const el of contentEl as JsonArray) {
		if (!isObject(el)) {
			continue;
		}
		const block = el as JsonObject;
		const blockType = getString(block, 'type');
		if (blockType === 'tool_result') {
			const c = block.content;
			if (typeof c === 'string' && c.length > MAX_TOOL_RESULT_CHARS) {
				needsCopy = true;
				break;
			}
		}
		if (blockType === 'text' && typeof block.text === 'string') {
			const s = block.text;
			if (s.length > MAX_ERROR_CONTENT_CHARS && isErrorContent(s)) {
				needsCopy = true;
				break;
			}
		}
	}

	if (!needsCopy) {
		return transport;
	}

	const copied = structuredClone(transport);
	const copiedContentEl = findContentElement(copied);
	if (copiedContentEl == null || !Array.isArray(copiedContentEl)) {
		return copied;
	}

	for (const el of copiedContentEl as JsonArray) {
		if (!isObject(el)) {
			continue;
		}
		const block = el as JsonObject;
		const blockType = getString(block, 'type');
		if (blockType === 'tool_result' && typeof block.content === 'string') {
			if (block.content.length > MAX_TOOL_RESULT_CHARS) {
				block.content = truncateString(block.content);
			}
		}
		if (blockType === 'text' && typeof block.text === 'string') {
			if (block.text.length > MAX_ERROR_CONTENT_CHARS && isErrorContent(block.text)) {
				block.text = truncateErrorContent(block.text);
			}
		}
	}

	return copied;
}

function buildTransportRaw(raw: JsonObject): JsonObject {
	const transport: JsonObject = {};
	copyFieldIfPresent(raw, transport, 'uuid');
	// opencode 消息 ID（msg_xxx）：undo / fork / revert 依赖它定位服务端消息
	copyFieldIfPresent(raw, transport, 'id');
	copyFieldIfPresent(raw, transport, 'type');
	copyFieldIfPresent(raw, transport, 'isMeta');
	copyFieldIfPresent(raw, transport, 'text');
	copyFieldIfPresent(raw, transport, 'isCompactSummary');
	copyFieldIfPresent(raw, transport, 'isVisibleInTranscriptOnly');
	copyFieldIfPresent(raw, transport, 'summarizeMetadata');
	copyFieldIfPresent(raw, transport, 'origin');
	copyFieldIfPresent(raw, transport, 'turnUsage');
	copyFieldIfPresent(raw, transport, 'turnCostUsd');
	copyToolUseResultIfPresent(raw, transport);

	if (raw.content !== undefined) {
		transport.content = structuredClone(raw.content);
	}

	const sourceMessage = getObj(raw, 'message');
	if (sourceMessage) {
		const transportMessage: JsonObject = {};
		if (sourceMessage.content !== undefined) {
			transportMessage.content = structuredClone(sourceMessage.content);
		}
		if (Object.keys(transportMessage).length > 0) {
			transport.message = transportMessage;
		}
	}

	return transport;
}

function findContentElement(raw: JsonObject): unknown {
	if (raw.content !== undefined) {
		return raw.content;
	}
	const message = getObj(raw, 'message');
	if (message && message.content !== undefined) {
		return message.content;
	}
	return null;
}

function copyFieldIfPresent(source: JsonObject, target: JsonObject, fieldName: string): void {
	if (source[fieldName] !== undefined) {
		target[fieldName] = structuredClone(source[fieldName]);
	}
}

function copyToolUseResultIfPresent(source: JsonObject, target: JsonObject): void {
	if (source.toolUseResult === undefined || source.toolUseResult === null) {
		return;
	}
	target.toolUseResult = truncateStringFields(structuredClone(source.toolUseResult));
}

function truncateStringFields(el: unknown): unknown {
	if (el == null) {
		return el;
	}
	if (typeof el === 'string') {
		return el.length > MAX_TOOL_RESULT_CHARS ? truncateString(el) : el;
	}
	if (typeof el !== 'object') {
		return el;
	}
	if (Array.isArray(el)) {
		return el.map((item) => truncateStringFields(item));
	}
	const obj = el as JsonObject;
	for (const key of Object.keys(obj)) {
		obj[key] = truncateStringFields(obj[key]);
	}
	return obj;
}

function truncateString(s: string): string {
	if (s.length <= MAX_TOOL_RESULT_CHARS) {
		return s;
	}
	const marker = `\n...\n(truncated, original length: ${s.length} chars)\n...\n`;
	const available = Math.max(0, MAX_TOOL_RESULT_CHARS - marker.length);
	const head = Math.floor((available * 2) / 3);
	const tail = available - head;
	return s.substring(0, head) + marker + s.substring(s.length - tail);
}

/** 从消息列表里找最后的 usage，推给前端（SessionCallbackAdapter 兜底用）。 */
export function findLastUsage(messages: ChatMessage[]): JsonObject | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!isObject(msg.raw)) {
			continue;
		}
		const raw = msg.raw as JsonObject;
		const message = getObj(raw, 'message');
		const usage = getObj(message, 'usage');
		if (usage) {
			return usage;
		}
	}
	return null;
}

/** 计算一个 {percentage,totalTokens,limit,usedTokens,maxTokens} 用量快照。 */
export function buildUsageSnapshot(
	messages: ChatMessage[],
	model: string | null,
	provider: string,
): { percentage: number; totalTokens: number; limit: number; usedTokens: number; maxTokens: number } | null {
	const lastUsage = findLastUsage(messages);
	if (!lastUsage) {
		return null;
	}
	const usedTokens = extractContextTokens(lastUsage, provider);
	const fallbackMax = getModelContextLimit(model);
	const maxTokens = extractMaxTokens(lastUsage, fallbackMax);
	const percentage = Math.min(100, maxTokens > 0 ? Math.round((usedTokens * 100) / maxTokens) : 0);
	return { percentage, totalTokens: usedTokens, limit: maxTokens, usedTokens, maxTokens };
}

function extractMaxTokens(usage: JsonObject, fallback: number): number {
	if (typeof usage.contextLimit === 'number' && usage.contextLimit > 0) {
		return Math.floor(usage.contextLimit);
	}
	if (typeof usage.maxTokens === 'number' && usage.maxTokens > 0) {
		return Math.floor(usage.maxTokens);
	}
	if (isObject(usage.tokens) && typeof (usage.tokens as JsonObject).context === 'number') {
		const context = (usage.tokens as JsonObject).context as number;
		if (context > 0) {
			return Math.floor(context);
		}
	}
	return fallback;
}
