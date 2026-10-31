/**
 * ListMessagesCollector — `opencode.listMessages` daemon 输出的增量解析器。
 *
 * daemon 侧（opencode-channel.js）按逐条消息输出 NDJSON：
 *   {"success":true,...,"messagesStart":true,"count":N}
 *   {"success":true,...,"messageEntry":{info,parts}}   × N
 *   {"success":true,...,"messagesDone":true,"count":N,
 *    "nextCursor":"…","previousCursor":"…","hasEarlier":true}
 *
 * 收集**一页**消息条目 + 该页的游标。opencode 2.x 的消息接口是分页的，
 * 「一页」不等于「全部」：调用方必须保留 `nextCursor`，否则长会话会被
 * 截断到最新一页而毫无提示。
 */
import type { SdkMessageEntry } from '../session/SdkMessageConverter';

export class ListMessagesCollector {
	private readonly entries: SdkMessageEntry[] = [];
	/** 无法识别的原始行（旧协议整包 / 诊断行），仅在兜底解析时使用。 */
	private readonly fallbackRaw: string[] = [];
	private done = false;
	private sawNewProtocol = false;
	/** 服务端 `cursor.next`：更早一页的游标（默认顺序为「新→旧」）。 */
	private nextCursor: string | null = null;
	/** 服务端 `cursor.previous`：更新一页的游标。 */
	private previousCursor: string | null = null;
	private hasEarlier = false;

	onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const obj = JSON.parse(trimmed) as Record<string, unknown>;
				if (obj.messageEntry !== undefined) {
					this.entries.push(obj.messageEntry as SdkMessageEntry);
					this.sawNewProtocol = true;
					return;
				}
				if (obj.messagesDone === true) {
					this.done = true;
					this.sawNewProtocol = true;
					this.nextCursor = typeof obj.nextCursor === 'string' && obj.nextCursor ? obj.nextCursor : null;
					this.previousCursor = typeof obj.previousCursor === 'string' && obj.previousCursor ? obj.previousCursor : null;
					// `hasEarlier` 由 daemon 依据游标算出；旧 daemon 不回该字段时
					// 退化为「有游标即有更早一页」。
					this.hasEarlier = typeof obj.hasEarlier === 'boolean'
						? obj.hasEarlier
						: Boolean(this.nextCursor);
					return;
				}
				if (obj.messagesStart === true) {
					this.sawNewProtocol = true;
					return;
				}
				// 旧协议整包：{"success":true,"messages":[...]}
				if (Array.isArray(obj.messages)) {
					for (const entry of obj.messages as SdkMessageEntry[]) {
						this.entries.push(entry);
					}
					this.done = true;
					return;
				}
			} catch {
				// 非 JSON —— 落入兜底缓存
			}
		}
		this.fallbackRaw.push(trimmed);
	}

	get isDone(): boolean {
		return this.done;
	}

	getEntries(): SdkMessageEntry[] {
		return this.entries;
	}

	getTotalMessageCount(): number {
		return this.entries.length;
	}

	/**
	 * Cursor of the next older page, or null when this page is the oldest.
	 *
	 * <p>On any page a `next` cursor may point past the real end (the filtered
	 * `type=user` pages do this), so callers must stop on the first empty page
	 * as well — never on the cursor alone.</p>
	 */
	getNextCursor(): string | null {
		return this.nextCursor;
	}

	getPreviousCursor(): string | null {
		return this.previousCursor;
	}

	getHasEarlier(): boolean {
		return this.hasEarlier;
	}

	getFirstRetainedMessageIndex(): number {
		return 0;
	}

	get hasParsedEntries(): boolean {
		return this.sawNewProtocol || this.entries.length > 0;
	}

	/**
	 * 兜底：从未识别的原始行里提取旧协议整包。仅当新协议完全没出现时调用。
	 */
	reconcileFallback(): void {
		if (this.sawNewProtocol || this.fallbackRaw.length === 0) {
			return;
		}
		const raw = this.fallbackRaw.join('\n');
		const payload = extractJsonObjectFromRaw(raw);
		if (payload && Array.isArray(payload.messages)) {
			for (const entry of payload.messages as SdkMessageEntry[]) {
				this.entries.push(entry);
			}
		}
	}
}

/** 从（可能混有诊断行的）原始输出中提取含 messages 的 JSON 对象。 */
export function extractJsonObjectFromRaw(raw: string): Record<string, unknown> | null {
	if (!raw || raw.trim() === '') {
		return null;
	}
	const lines = raw.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith('{') || !line.endsWith('}')) {
			continue;
		}
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (obj && (obj.messages !== undefined || obj.success !== undefined)) {
				return obj;
			}
		} catch {
			// 跳过
		}
	}
	try {
		const start = raw.lastIndexOf('{');
		const end = raw.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(raw.substring(start, end + 1)) as Record<string, unknown>;
		}
	} catch {
		// 忽略
	}
	return null;
}
