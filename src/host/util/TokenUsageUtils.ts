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
export function extractContextTokens(usage: unknown, _provider: string): number {
	if (!isObject(usage)) {
		return 0;
	}
	const obj = usage as Record<string, unknown>;

	// 1) OpenCode SDK message usage: { tokens: { input, output } }
	const tokens = obj.tokens;
	if (isObject(tokens)) {
		const t = tokens as Record<string, unknown>;
		const input = asNonNegative(t.input);
		if (input >= 0) {
			return input;
		}
	}

	// 2) Flat OpenCode/Anthropic variants
	for (const key of ['input_tokens', 'inputTokens', 'input']) {
		const v = asNonNegative(obj[key]);
		if (v >= 0) {
			return v;
		}
	}

	// 3) Some opencode sessions report total context occupancy directly.
	const contextTokens = asNonNegative(obj.contextTokens);
	if (contextTokens >= 0) {
		return contextTokens;
	}

	return 0;
}

function asNonNegative(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return -1;
	}
	return Math.max(0, Math.floor(value));
}
