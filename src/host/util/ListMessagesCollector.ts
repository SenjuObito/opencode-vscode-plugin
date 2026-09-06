/**
 * ListMessagesCollector — `opencode.listMessages` daemon 输出的增量解析器。
 *
 * daemon 侧（opencode-channel.js）按逐条消息输出 NDJSON：
 *   {"success":true,...,"messagesStart":true,"count":N}
 *   {"success":true,...,"messageEntry":{info,parts}}   × N
 *   {"success":true,...,"messagesDone":true,"count":N}
 *
 * 窗口化保留（大型会话内存治理 P3）：opencode SDK 无分页参数，每次请求
 * 都会传输全量 transcript——但宿主不必持有全量。collector 在逐行解析时
 * 按「消息序号区间」决定保留/丢弃，峰值内存 = 窗口而非全量：
 *   - { mode:'tail', messageLimit }  恢复路径：只保留最近 N 条消息；
 *   - { mode:'range', start, end }   分页回源：只保留 [start,end) 消息区间。
 * 每条 entry 展开的消息数由 estimateEntryMessageCount 计算（与
 * SdkMessageConverter.convertSdkMessage 的展开规则严格一致，两处需同步修改）。
 *
 * 兼容：旧协议（单行整包 `{messages:[...]}`）或混入的非 JSON 诊断行走
 * fallbackRaw 兜底（整包解析后同样应用保留规则）。
 */
import type { SdkMessageEntry } from '../session/SdkMessageConverter';

export type EntryRetention =
	| { mode: 'tail'; messageLimit: number }
	| { mode: 'range'; start: number; end: number };

/**
 * 估算一条 SDK entry 展开后的消息数。
 * 必须与 SdkMessageConverter.convertSdkMessage 保持一致：
 *   user → 1；assistant → 1 + (带 string output/error 的 tool part 数)；其他 role → 0。
 */
function estimateEntryMessageCount(entry: SdkMessageEntry): number {
	const info = entry?.info ?? {};
	const role = typeof info.role === 'string' ? info.role : '';
	if (role === 'user') {
		return 1;
	}
	if (role !== 'assistant') {
		return 0;
	}
	const parts = Array.isArray(entry?.parts) ? entry.parts : [];
	let count = 1;
	for (const part of parts) {
		if (!part || part.type !== 'tool') {
			continue;
		}
		const state = part.state && typeof part.state === 'object' ? part.state : {};
		if (typeof state.output === 'string' || typeof state.error === 'string') {
			count++;
		}
	}
	return count;
}

export class ListMessagesCollector {
	private readonly retention?: EntryRetention;
	private readonly entries: SdkMessageEntry[] = [];
	/** 无法识别的原始行（旧协议整包 / 诊断行），仅在兜底解析时使用。 */
	private readonly fallbackRaw: string[] = [];
	/** 全 transcript 的消息总数（含未保留的区间）。 */
	private msgCountTotal = 0;
	/** entries[0] 的全局消息序号。 */
	private firstRetainedMsgIndex = 0;
	/** 当前保留的消息条数。 */
	private retainedMsgCount = 0;
	private done = false;
	private sawNewProtocol = false;

	constructor(retention?: EntryRetention) {
		this.retention = retention;
	}

	onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const obj = JSON.parse(trimmed) as Record<string, unknown>;
				if (obj.messageEntry !== undefined) {
					this.acceptEntry(obj.messageEntry as SdkMessageEntry);
					this.sawNewProtocol = true;
					return;
				}
				if (obj.messagesDone === true) {
					this.done = true;
					this.sawNewProtocol = true;
					return;
				}
				if (obj.messagesStart === true) {
					this.sawNewProtocol = true;
					return;
				}
				// 旧协议整包：{"success":true,"messages":[...]}
				if (Array.isArray(obj.messages)) {
					for (const entry of obj.messages as SdkMessageEntry[]) {
						this.acceptEntry(entry);
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

	/** 按保留策略决定 entry 去留，并累计全局消息序号。 */
	private acceptEntry(entry: SdkMessageEntry): void {
		const count = estimateEntryMessageCount(entry);
		const start = this.msgCountTotal;
		this.msgCountTotal += count;
		if (count === 0) {
			return;
		}
		const retention = this.retention;
		let keep: boolean;
		if (!retention) {
			keep = true;
		} else if (retention.mode === 'range') {
			keep = start < retention.end && start + count > retention.start;
		} else {
			// tail：先保留，超出限额再从头部丢弃
			keep = true;
		}
		if (!keep) {
			return;
		}
		this.entries.push(entry);
		this.retainedMsgCount += count;
		if (retention?.mode === 'tail') {
			while (this.retainedMsgCount > retention.messageLimit && this.entries.length > 0) {
				const oldest = this.entries.shift();
				const oldestCount = oldest ? estimateEntryMessageCount(oldest) : 0;
				this.firstRetainedMsgIndex += oldestCount;
				this.retainedMsgCount -= oldestCount;
			}
		}
	}

	get isDone(): boolean {
		return this.done;
	}

	getEntries(): SdkMessageEntry[] {
		return this.entries;
	}

	/** 全 transcript 消息总数。 */
	getTotalMessageCount(): number {
		return this.msgCountTotal;
	}

	/** entries[0] 的全局消息序号（tail 模式下 = 被丢弃的头部条数）。 */
	getFirstRetainedMessageIndex(): number {
		return this.firstRetainedMsgIndex;
	}

	/**
	 * 新协议没等到 messagesDone（流被截断）时，已解析的 entries 仍视为有效
	 * 结果——逐条协议天然是前缀安全的。
	 */
	get hasParsedEntries(): boolean {
		return this.sawNewProtocol || this.entries.length > 0;
	}

	/**
	 * 兜底：从未识别的原始行里提取旧协议整包（HistoryHandler.extractJsonObject
	 * 的逻辑等价实现），把结果按保留规则并入 entries。仅当新协议完全没出现时调用。
	 */
	reconcileFallback(): void {
		if (this.sawNewProtocol || this.fallbackRaw.length === 0) {
			return;
		}
		const raw = this.fallbackRaw.join('\n');
		const payload = extractJsonObjectFromRaw(raw);
		if (payload && Array.isArray(payload.messages)) {
			for (const entry of payload.messages as SdkMessageEntry[]) {
				this.acceptEntry(entry);
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
