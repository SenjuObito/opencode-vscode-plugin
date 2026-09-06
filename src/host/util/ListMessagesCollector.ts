/**
 * ListMessagesCollector — `opencode.listMessages` daemon 输出的增量解析器。
 *
 * daemon 侧（opencode-channel.js）按逐条消息输出 NDJSON：
 *   {"success":true,...,"messagesStart":true,"count":N}
 *   {"success":true,...,"messageEntry":{info,parts}}   × N
 *   {"success":true,...,"messagesDone":true,"count":N}
 *
 * 此前 daemon 整包输出单行 JSON：daemon stdout 拦截器要再 stringify 一次
 * （转义膨胀 ~1.5x），宿主 chunks[] 累积 + join + extractJsonObject 全文
 * 扫描又是多次整包拷贝——长会话恢复时三进程内存峰值 5-8 倍，是 OOM 主因。
 * 逐条输出后每行都是小字符串，这里逐行 parse、只保留解析后的 entry 对象。
 *
 * 兼容：若输出是旧协议（单行整包 `{messages:[...]}`）或混入非 JSON 诊断行，
 * 无法识别的行会缓存到 fallbackRaw，结束时按旧的整包提取逻辑兜底解析。
 */
import type { SdkMessageEntry } from '../session/SdkMessageConverter';

export class ListMessagesCollector {
	private readonly entries: SdkMessageEntry[] = [];
	/** 无法识别的原始行（旧协议整包 / 诊断行），仅在兜底解析时使用。 */
	private readonly fallbackRaw: string[] = [];
	private done = false;
	private sawNewProtocol = false;

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
					return;
				}
				if (obj.messagesStart === true) {
					this.sawNewProtocol = true;
					return;
				}
				// 旧协议整包：{"success":true,"messages":[...]}
				if (Array.isArray(obj.messages)) {
					this.entries.push(...(obj.messages as SdkMessageEntry[]));
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

	/**
	 * 新协议没等到 messagesDone（流被截断）时，已解析的 entries 仍视为有效
	 * 结果——逐条协议天然是前缀安全的。
	 */
	get hasParsedEntries(): boolean {
		return this.sawNewProtocol || this.entries.length > 0;
	}

	/**
	 * 兜底：从未识别的原始行里提取旧协议整包（HistoryHandler.extractJsonObject
	 * 的逻辑等价实现），把结果并入 entries。仅当新协议完全没出现时调用。
	 */
	reconcileFallback(): void {
		if (this.sawNewProtocol || this.fallbackRaw.length === 0) {
			return;
		}
		const raw = this.fallbackRaw.join('\n');
		const payload = extractJsonObjectFromRaw(raw);
		if (payload && Array.isArray(payload.messages)) {
			this.entries.push(...(payload.messages as SdkMessageEntry[]));
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
