/**
 * MessageParser — port of cc-gui `session/MessageParser.java`.
 * Parses SDK-returned messages into ChatMessage objects.
 */
import { ChatMessage, MessageType } from './types';
import { createMessage } from './SessionState';
import { isObject, isArray, getObj, getObjArray, getString, JsonObject, JsonArray } from './jsonUtils';

export class MessageParser {
	/**
	 * Parse a server-returned message.
	 * @returns null when the message should be filtered out.
	 */
	parseServerMessage(msg: JsonObject | null): ChatMessage | null {
		if (!msg) {
			return null;
		}
		const type = typeof msg.type === 'string' ? msg.type : null;
		const rawMessage = this.resolveRawMessage(msg);

		// 过滤 isMeta 消息
		if (msg.isMeta === true) {
			return null;
		}

		// 过滤 sidechain（子 agent）消息
		if (msg.isSidechain === true) {
			return null;
		}

		// 过滤命令消息（仅 user 消息；assistant 消息可能包含示例代码）
		if (this.shouldFilterCommandMessage(rawMessage, type)) {
			return null;
		}

		if (type === 'user') {
			const content = this.extractMessageContent(msg);
			if (!content || content.trim() === '') {
				if (this.hasToolResult(rawMessage)) {
					return createMessage(MessageType.USER, '[tool_result]', rawMessage);
				}
				if (this.hasImageContent(rawMessage)) {
					return createMessage(MessageType.USER, '', rawMessage);
				}
				return null;
			}
			return createMessage(MessageType.USER, content, rawMessage);
		}

		if (type === 'assistant') {
			const content = this.extractMessageContent(msg);
			return createMessage(MessageType.ASSISTANT, content, rawMessage);
		}

		return null;
	}

	/**
	 * 历史适配层可能返回已归一化的前端信封，其结构化 SDK 载荷在 `raw` 中。
	 * 会话状态只保留该载荷，否则 MessageJsonConverter 会丢弃嵌套的 tool_use/tool_result。
	 */
	private resolveRawMessage(msg: JsonObject): JsonObject {
		const raw = msg.raw;
		if (isObject(raw)) {
			return raw as JsonObject;
		}
		return msg;
	}

	hasToolResult(msg: JsonObject | null): boolean {
		return this.hasContentBlockType(msg, 'tool_result');
	}

	hasImageContent(msg: JsonObject | null): boolean {
		return this.hasContentBlockType(msg, 'image');
	}

	extractMessageContent(msg: JsonObject | null): string {
		if (!msg) {
			return '';
		}
		if (!msg.message) {
			if (msg.content !== undefined) {
				return this.extractContentFromElement(msg.content);
			}
			return '';
		}
		const message = getObj(msg, 'message');
		if (!message || message.content === undefined || message.content === null) {
			return '';
		}
		return this.extractContentFromElement(message.content);
	}

	private shouldFilterCommandMessage(msg: JsonObject | null, type: string | null): boolean {
		if (type !== 'user') {
			return false;
		}
		const message = getObj(msg, 'message');
		if (!message) {
			return false;
		}
		if (message.content === undefined) {
			return false;
		}
		let contentStr: string | null = null;
		const contentElement = message.content;

		if (typeof contentElement === 'string') {
			contentStr = contentElement;
		} else if (isArray(contentElement)) {
			for (const element of contentElement as JsonArray) {
				if (isObject(element)) {
					const block = element as JsonObject;
					if (block.type === 'text' && typeof block.text === 'string') {
						contentStr = block.text;
						break;
					}
				}
			}
		}

		if (contentStr != null) {
			const hasCommandMessage =
				contentStr.includes('<command-message>') && contentStr.includes('</command-message>');
			if (
				!hasCommandMessage &&
				(contentStr.includes('<command-name>') ||
					contentStr.includes('<local-command-stdout>') ||
					contentStr.includes('<local-command-stderr>') ||
					contentStr.includes('<command-args>'))
			) {
				return true;
			}
		}
		return false;
	}

	private hasContentBlockType(msg: JsonObject | null, blockType: string): boolean {
		if (!msg) {
			return false;
		}
		if (msg.content !== undefined && this.containsContentBlockType(msg.content, blockType)) {
			return true;
		}
		const message = getObj(msg, 'message');
		if (message && message.content !== undefined && this.containsContentBlockType(message.content, blockType)) {
			return true;
		}
		return false;
	}

	private containsContentBlockType(contentElement: unknown, blockType: string): boolean {
		if (!isArray(contentElement)) {
			return false;
		}
		for (const element of contentElement as JsonArray) {
			if (isObject(element)) {
				const block = element as JsonObject;
				if (block.type === blockType) {
					return true;
				}
			}
		}
		return false;
	}

	private extractContentFromElement(contentElement: unknown): string {
		if (typeof contentElement === 'string') {
			return contentElement;
		}
		if (isArray(contentElement)) {
			return this.extractFromArrayContent(contentElement as JsonArray);
		}
		if (isObject(contentElement)) {
			const contentObj = contentElement as JsonObject;
			if (typeof contentObj.text === 'string') {
				return contentObj.text;
			}
		}
		return '';
	}

	private extractFromArrayContent(contentArray: JsonArray): string {
		const parts: string[] = [];
		let hasContent = false;
		for (const element of contentArray) {
			if (isObject(element)) {
				const block = element as JsonObject;
				const blockType = typeof block.type === 'string' ? block.type : null;
				if (blockType === 'text' && typeof block.text === 'string') {
					if (parts.length > 0) {
						parts.push('\n');
					}
					parts.push(block.text);
					hasContent = true;
				}
				// tool_use / thinking / image 块不显示文本
			} else if (typeof element === 'string') {
				const text = element;
				if (text && text.trim() !== '') {
					if (parts.length > 0) {
						parts.push('\n');
					}
					parts.push(text);
					hasContent = true;
				}
			}
		}
		return parts.join('');
	}
}
