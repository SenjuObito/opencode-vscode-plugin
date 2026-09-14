/**
 * TokenUsageUtils — port of cc-gui `util/TokenUsageUtils.java`.
 * Extracts context-token counts from usage payloads. OpenCode's SDK usage
 * shape differs from Anthropic's; try every known layout defensively.
 */
import { isObject } from '../session/jsonUtils';

/**
 * Extract the context (input) token count from a usage JSON object.
 * Recognized shapes:
 *   - Anthropic:  { input_tokens, output_tokens }
 *   - OpenCode v2 message: { tokens: { input, output } }
 *   - OpenCode flat: { inputTokens, outputTokens }
 *   - OpenCode session usage: { contextTokens }
 * Returns 0 when nothing usable is found.
 */
export function extractContextTokens(usage: unknown, _provider?: string): number {
	if (!isObject(usage)) {
		return 0;
	}
	const obj = usage as Record<string, unknown>;

	// 1) OpenCode SDK message / turn usage: { tokens: { input, output, cache: { read, write } } }
	// or usage object having { input, cache: { read, write } } directly
	const tokensObj = isObject(obj.tokens) ? (obj.tokens as Record<string, unknown>) : obj;
	if (isObject(tokensObj)) {
		const input = asNonNegative(tokensObj.input);
		const cache = isObject(tokensObj.cache) ? (tokensObj.cache as Record<string, unknown>) : null;
		const cacheRead = cache ? asNonNegative(cache.read) : -1;
		const cacheWrite = cache ? asNonNegative(cache.write) : -1;

		if (input >= 0 || cacheRead >= 0 || cacheWrite >= 0) {
			const safeInput = input >= 0 ? input : 0;
			const safeRead = cacheRead >= 0 ? cacheRead : 0;
			const safeWrite = cacheWrite >= 0 ? cacheWrite : 0;
			const total = safeInput + safeRead + safeWrite;
			if (total > 0 || (input === 0 && cacheRead <= 0 && cacheWrite <= 0)) {
				return total;
			}
		}
	}

	// 2) Flat OpenCode/Anthropic variants with cache fields:
	//    { input_tokens, cache_read_input_tokens, cache_creation_input_tokens }
	const flatInput = asNonNegative(obj.input_tokens ?? obj.inputTokens ?? obj.input);
	const flatCacheRead = asNonNegative(obj.cache_read_input_tokens ?? obj.cacheReadInputTokens ?? obj.cache_read);
	const flatCacheWrite = asNonNegative(
		obj.cache_creation_input_tokens ?? obj.cacheCreationInputTokens ?? obj.cache_write ?? obj.cache_creation,
	);

	if (flatInput >= 0 || flatCacheRead >= 0 || flatCacheWrite >= 0) {
		const safeInput = flatInput >= 0 ? flatInput : 0;
		const safeRead = flatCacheRead >= 0 ? flatCacheRead : 0;
		const safeWrite = flatCacheWrite >= 0 ? flatCacheWrite : 0;
		return safeInput + safeRead + safeWrite;
	}

	// 3) Direct context occupancy field
	const contextTokens = asNonNegative(obj.contextTokens ?? obj.totalTokens);
	if (contextTokens >= 0) {
		return contextTokens;
	}

	return 0;
}

/**
 * Scan assistant messages from end to find the most recent usage snapshot.
 * Checks msg.raw.turnUsage, msg.raw.tokens, msg.raw.usage, and msg.raw.message.usage.
 */
export function findLastUsageFromMessages(messages: unknown[]): Record<string, unknown> | null {
	if (!Array.isArray(messages)) {
		return null;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { type?: string; raw?: Record<string, unknown> } | null;
		if (!m || m.type !== 'assistant' || !isObject(m.raw)) {
			continue;
		}
		const raw = m.raw;
		if (isObject(raw.turnUsage)) {
			return raw.turnUsage as Record<string, unknown>;
		}
		if (isObject(raw.tokens)) {
			return raw.tokens as Record<string, unknown>;
		}
		if (isObject(raw.usage)) {
			return raw.usage as Record<string, unknown>;
		}
		const msg = isObject(raw.message) ? (raw.message as Record<string, unknown>) : null;
		if (msg && isObject(msg.usage)) {
			return msg.usage as Record<string, unknown>;
		}
	}
	return null;
}

function asNonNegative(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return -1;
	}
	return Math.max(0, Math.floor(value));
}
