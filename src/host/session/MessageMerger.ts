/**
 * MessageMerger — port of cc-gui `session/MessageMerger.java`.
 * Merges streaming assistant messages so previously displayed tool steps are
 * not overwritten.
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

const MAX_OVERLAP = 200;

export class MessageMerger {
	/** Merge streaming assistant messages. */
	mergeAssistantMessage(existingRaw: JsonObject | null, newRaw: JsonObject | null): JsonObject | null {
		if (newRaw == null) {
			return existingRaw != null ? structuredClone(existingRaw) : null;
		}
		if (existingRaw == null) {
			return structuredClone(newRaw);
		}

		const merged = structuredClone(existingRaw);

		// 合并顶层字段（除 "message"）
		for (const [key, value] of Object.entries(newRaw)) {
			if (key === 'message') {
				continue;
			}
			merged[key] = structuredClone(value);
		}

		const incomingMessage = getObj(newRaw, 'message');
		if (!incomingMessage) {
			return merged;
		}

		const mergedMessage: JsonObject = isObject(merged.message) ? (merged.message as JsonObject) : {};

		// 复制新元数据（保留最新 stop_reason、usage 等）
		for (const [key, value] of Object.entries(incomingMessage)) {
			if (key === 'content') {
				continue;
			}
			mergedMessage[key] = structuredClone(value);
		}

		this.mergeAssistantContentArray(mergedMessage, incomingMessage);
		merged.message = mergedMessage;
		return merged;
	}

	private mergeAssistantContentArray(targetMessage: JsonObject, incomingMessage: JsonObject): void {
		const baseContent: JsonArray = isArray(targetMessage.content) ? (targetMessage.content as JsonArray) : [];
		const indexByKey = this.buildContentIndex(baseContent);
		const consumedUnkeyedIndexes = new Set<number>();

		const incomingContent = getObjArray(incomingMessage, 'content');
		if (!incomingContent) {
			targetMessage.content = baseContent;
			return;
		}

		for (let i = 0; i < incomingContent.length; i++) {
			const element = incomingContent[i];
			const elementCopy = structuredClone(element);

			if (isObject(element)) {
				const block = element as JsonObject;
				const key = this.getContentBlockKey(block);
				if (key != null && indexByKey.has(key)) {
					const idx = indexByKey.get(key)!;
					baseContent[idx] = elementCopy;
					continue;
				}
				if (key != null) {
					baseContent.push(elementCopy);
					indexByKey.set(key, baseContent.length - 1);
					continue;
				}

				const idx = this.findMatchingUnkeyedBlockIndex(baseContent, block, consumedUnkeyedIndexes);
				if (idx >= 0) {
					const existing = baseContent[idx];
					baseContent[idx] = this.mergeUnkeyedBlock(
						isObject(existing) ? (existing as JsonObject) : {},
						block,
					);
					consumedUnkeyedIndexes.add(idx);
					continue;
				}

				// 兜底：与尾部最后一个同类型块合并而不是追加重复
				const lastSameTypeIdx = this.findLastSameTypeBlockIndex(baseContent, block);
				if (lastSameTypeIdx >= 0) {
					const existing = baseContent[lastSameTypeIdx];
					baseContent[lastSameTypeIdx] = this.mergeUnkeyedBlock(
						isObject(existing) ? (existing as JsonObject) : {},
						block,
					);
					continue;
				}
			}

			baseContent.push(elementCopy);
		}

		targetMessage.content = baseContent;
	}

	private buildContentIndex(contentArray: JsonArray): Map<string, number> {
		const index = new Map<string, number>();
		for (let i = 0; i < contentArray.length; i++) {
			const element = contentArray[i];
			if (!isObject(element)) {
				continue;
			}
			const block = element as JsonObject;
			const key = this.getContentBlockKey(block);
			if (key != null && !index.has(key)) {
				index.set(key, i);
			}
		}
		return index;
	}

	private getContentBlockKey(block: JsonObject): string | null {
		if (typeof block.id === 'string') {
			return block.id;
		}
		if (typeof block.tool_use_id === 'string') {
			return `tool_result:${block.tool_use_id}`;
		}
		return null;
	}

	private findMatchingUnkeyedBlockIndex(
		baseContent: JsonArray,
		incomingBlock: JsonObject,
		consumedUnkeyedIndexes: Set<number>,
	): number {
		const incomingType = this.getContentBlockType(incomingBlock);
		if (incomingType == null) {
			return -1;
		}
		for (let i = 0; i < baseContent.length; i++) {
			if (consumedUnkeyedIndexes.has(i)) {
				continue;
			}
			const existingElement = baseContent[i];
			if (!isObject(existingElement)) {
				continue;
			}
			const existingBlock = existingElement as JsonObject;
			if (this.getContentBlockKey(existingBlock) != null) {
				continue;
			}
			if (incomingType !== this.getContentBlockType(existingBlock)) {
				continue;
			}
			if (this.blocksLikelyRepresentSameSegment(existingBlock, incomingBlock)) {
				return i;
			}
		}
		return -1;
	}

	private mergeUnkeyedBlock(existingBlock: JsonObject, incomingBlock: JsonObject): JsonObject {
		const type = this.getContentBlockType(incomingBlock);
		const merged = structuredClone(incomingBlock);

		if (type === 'text') {
			merged.text = this.preferMoreCompleteContent(
				this.getTextContent(existingBlock),
				this.getTextContent(incomingBlock),
			);
			return merged;
		}

		if (type === 'thinking') {
			const thinking = this.preferMoreCompleteContent(
				this.getThinkingContent(existingBlock),
				this.getThinkingContent(incomingBlock),
			);
			if (thinking) {
				merged.thinking = thinking;
				merged.text = thinking;
			}
		}

		return merged;
	}

	private blocksLikelyRepresentSameSegment(existingBlock: JsonObject, incomingBlock: JsonObject): boolean {
		const type = this.getContentBlockType(incomingBlock);
		if (type == null || type !== this.getContentBlockType(existingBlock)) {
			return false;
		}

		if (type === 'text') {
			return this.textLooksRelatedStrict(this.getTextContent(existingBlock), this.getTextContent(incomingBlock));
		}

		if (type === 'thinking') {
			const existingThinking = this.getThinkingContent(existingBlock);
			const incomingThinking = this.getThinkingContent(incomingBlock);
			// 早期流式期间 thinking 可能尚未填充，仅类型匹配即可确定块身份。
			if (!existingThinking || !incomingThinking) {
				return true;
			}
			return this.textLooksRelated(existingThinking, incomingThinking);
		}

		return JSON.stringify(existingBlock) === JSON.stringify(incomingBlock);
	}

	private findLastSameTypeBlockIndex(baseContent: JsonArray, incomingBlock: JsonObject): number {
		const incomingType = this.getContentBlockType(incomingBlock);
		if (incomingType == null) {
			return -1;
		}
		// 只考虑 baseContent 尾部，不越过 keyed 块（tool_use、tool_result）。
		for (let i = baseContent.length - 1; i >= 0; i--) {
			const element = baseContent[i];
			if (!isObject(element)) {
				continue;
			}
			const existingBlock = element as JsonObject;
			if (this.getContentBlockKey(existingBlock) != null) {
				break;
			}
			if (
				incomingType === this.getContentBlockType(existingBlock) &&
				this.blocksLikelyRepresentSameSegment(existingBlock, incomingBlock)
			) {
				return i;
			}
		}
		return -1;
	}

	private getContentBlockType(block: JsonObject): string | null {
		return getString(block, 'type');
	}

	private getTextContent(block: JsonObject): string {
		return typeof block.text === 'string' ? block.text : '';
	}

	private getThinkingContent(block: JsonObject): string {
		if (typeof block.thinking === 'string') {
			return block.thinking;
		}
		return this.getTextContent(block);
	}

	private isPrefixRelated(existing: string, incoming: string): boolean {
		return (
			existing === incoming || existing.startsWith(incoming) || incoming.startsWith(existing)
		);
	}

	private textLooksRelatedStrict(existingText: string, incomingText: string): boolean {
		const existing = existingText ?? '';
		const incoming = incomingText ?? '';
		return this.isPrefixRelated(existing, incoming);
	}

	private textLooksRelated(existingText: string, incomingText: string): boolean {
		const existing = existingText ?? '';
		const incoming = incomingText ?? '';

		if (!existing || !incoming) {
			return !existing && !incoming;
		}
		if (this.isPrefixRelated(existing, incoming)) {
			return true;
		}

		// 后缀-前缀重叠检查（流式可能产生部分重叠）
		const maxOverlap = Math.min(existing.length, incoming.length, MAX_OVERLAP);
		for (let overlap = maxOverlap; overlap > 0; overlap--) {
			if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
				return true;
			}
		}
		return false;
	}

	private preferMoreCompleteContent(existingText: string, incomingText: string): string {
		const existing = existingText ?? '';
		const incoming = incomingText ?? '';
		if (!incoming) {
			return existing;
		}
		if (!existing) {
			return incoming;
		}
		if (incoming.startsWith(existing)) {
			return incoming;
		}
		if (existing.startsWith(incoming)) {
			return existing;
		}
		return incoming.length >= existing.length ? incoming : existing;
	}
}
