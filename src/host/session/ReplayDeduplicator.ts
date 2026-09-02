/**
 * ReplayDeduplicator — port of cc-gui `session/ReplayDeduplicator.java`.
 * Deduplicates streaming deltas that were already included via conservative
 * full-message sync. Not thread-safe; called from the daemon callback thread.
 */
import { JsonObject, JsonArray, isObject, isArray, getObj, getObjArray } from './jsonUtils';

export const NO_SYNCED_REPLAY = -1;

export class ReplayDeduplicator {
	private syncedContentOffset = NO_SYNCED_REPLAY;
	private syncedContentReplay: string | null = null;
	private syncedThinkingOffset = NO_SYNCED_REPLAY;
	private syncedThinkingReplay: string | null = null;

	reset(): void {
		this.syncedContentOffset = NO_SYNCED_REPLAY;
		this.syncedContentReplay = null;
		this.syncedThinkingOffset = NO_SYNCED_REPLAY;
		this.syncedThinkingReplay = null;
	}

	static replayOffset(fallbackOffset: number, currentOffset: number): number {
		return currentOffset >= 0 ? currentOffset : fallbackOffset;
	}

	beginContentReplay(replayContent: string | null, offset: number): void {
		if (replayContent == null || offset >= replayContent.length) {
			this.syncedContentReplay = null;
			this.syncedContentOffset = NO_SYNCED_REPLAY;
			return;
		}
		this.syncedContentReplay = replayContent;
		this.syncedContentOffset = Math.max(0, offset);
	}

	beginThinkingReplay(replayContent: string | null, offset: number): void {
		if (replayContent == null || offset >= replayContent.length) {
			this.syncedThinkingReplay = null;
			this.syncedThinkingOffset = NO_SYNCED_REPLAY;
			return;
		}
		this.syncedThinkingReplay = replayContent;
		this.syncedThinkingOffset = Math.max(0, offset);
	}

	contentOffset(): number {
		return this.syncedContentOffset;
	}

	thinkingOffset(): number {
		return this.syncedThinkingOffset;
	}

	consumeContentDelta(delta: string): string {
		const result = this.consumeSyncedReplay(delta, this.syncedContentReplay, this.syncedContentOffset);
		this.syncedContentReplay = result.replayContent;
		this.syncedContentOffset = result.offset;
		return result.novelDelta;
	}

	consumeThinkingDelta(delta: string): string {
		const result = this.consumeSyncedReplay(delta, this.syncedThinkingReplay, this.syncedThinkingOffset);
		this.syncedThinkingReplay = result.replayContent;
		this.syncedThinkingOffset = result.offset;
		return result.novelDelta;
	}

	private consumeSyncedReplay(
		delta: string,
		replayContent: string | null,
		offset: number,
	): { novelDelta: string; replayContent: string | null; offset: number } {
		if (!delta || !replayContent || offset < 0) {
			return { novelDelta: delta, replayContent: null, offset: NO_SYNCED_REPLAY };
		}

		const safeOffset = Math.min(Math.max(0, offset), replayContent.length);
		let replayIndex = safeOffset;

		let consumed = 0;
		while (
			consumed < delta.length &&
			replayIndex + consumed < replayContent.length &&
			replayContent.charAt(replayIndex + consumed) === delta.charAt(consumed)
		) {
			consumed++;
		}
		// 兜底：偏移匹配失败时，检查 delta 是否匹配 replay 尾部（部分同步后的偏移漂移）。
		if (
			consumed === 0 &&
			replayContent.length > safeOffset &&
			replayContent.endsWith(delta) &&
			replayContent.lastIndexOf(delta) >= safeOffset
		) {
			replayIndex = replayContent.length - delta.length;
			consumed = delta.length;
		} else if (consumed === 0) {
			return { novelDelta: delta, replayContent: null, offset: NO_SYNCED_REPLAY };
		}

		const nextOffset = replayIndex + consumed;
		const novelDelta = delta.substring(consumed);
		if (nextOffset >= replayContent.length) {
			return { novelDelta, replayContent: null, offset: NO_SYNCED_REPLAY };
		}
		return { novelDelta, replayContent, offset: nextOffset };
	}

	// ── 静态提取助手 ──

	static extractThinkingContent(raw: JsonObject | null | undefined): string {
		if (!raw) {
			return '';
		}
		const message = getObj(raw, 'message');
		const contentArray = getObjArray(message, 'content');
		if (!contentArray) {
			return '';
		}
		const parts: string[] = [];
		for (const element of contentArray) {
			if (!isObject(element)) {
				continue;
			}
			const block = element as JsonObject;
			const type = typeof block.type === 'string' ? block.type : '';
			if (type !== 'thinking') {
				continue;
			}
			let thinking = '';
			if (typeof block.thinking === 'string') {
				thinking = block.thinking;
			} else if (typeof block.text === 'string') {
				thinking = block.text;
			}
			if (thinking) {
				if (parts.length > 0) {
					parts.push('\n');
				}
				parts.push(thinking);
			}
		}
		return parts.join('');
	}

	static extractTextContent(raw: JsonObject | null | undefined): string {
		if (!raw) {
			return '';
		}
		const message = getObj(raw, 'message');
		const contentArray = getObjArray(message, 'content');
		if (!contentArray) {
			return '';
		}
		const parts: string[] = [];
		for (const element of contentArray) {
			if (!isObject(element)) {
				continue;
			}
			const block = element as JsonObject;
			const type = typeof block.type === 'string' ? block.type : '';
			if (type === 'text' && typeof block.text === 'string') {
				parts.push(block.text);
			}
		}
		return parts.join('');
	}

	static syncSegmentActivity(raw: JsonObject | null | undefined): SegmentActivity {
		const message = getObj(raw, 'message');
		const contentArray = getObjArray(message, 'content');
		if (!contentArray) {
			return new SegmentActivity(false, false);
		}
		for (let i = contentArray.length - 1; i >= 0; i--) {
			const element = contentArray[i];
			if (!isObject(element)) {
				continue;
			}
			const block = element as JsonObject;
			if (typeof block.type !== 'string') {
				continue;
			}
			const type = block.type;
			return new SegmentActivity(type === 'text', type === 'thinking');
		}
		return new SegmentActivity(false, false);
	}
}

export class SegmentActivity {
	readonly textActive: boolean;
	readonly thinkingActive: boolean;

	constructor(textActive: boolean, thinkingActive: boolean) {
		this.textActive = textActive;
		this.thinkingActive = thinkingActive;
	}
}

export type { JsonArray, JsonObject };
