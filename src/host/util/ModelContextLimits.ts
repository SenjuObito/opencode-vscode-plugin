/**
 * Model context limits — port of cc-gui `SettingsHandler.getModelContextLimit`.
 * Used to compute the context-usage percentage in the toolbar TokenCircle.
 * OpenCode models default to 200k; a handful of known limits are pinned.
 */
const KNOWN_LIMITS: Record<string, number> = {
	// Anthropic / Claude Code 模型（opencode 内部可用的常见后端）
	'claude-sonnet-4-5': 200_000,
	'claude-sonnet-4-7': 200_000,
	'claude-opus-4': 200_000,
	'claude-opus-4-1': 200_000,
	'claude-3-7-sonnet': 200_000,
	'gpt-5': 400_000,
	'gpt-5-codex': 400_000,
	'gpt-4o': 128_000,
	// OpenCode 自带 agent/model 名
	default: 200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

export function getModelContextLimit(model: string | null | undefined): number {
	if (!model) {
		return DEFAULT_CONTEXT_LIMIT;
	}
	const normalized = model.trim();
	// 精确匹配，再前缀匹配（例如 "claude-sonnet-4-7[1m]" 或 "gpt-5-codex-fast"）
	if (KNOWN_LIMITS[normalized] != null) {
		return KNOWN_LIMITS[normalized];
	}
	for (const [name, limit] of Object.entries(KNOWN_LIMITS)) {
		if (name !== 'default' && normalized.startsWith(name)) {
			return limit;
		}
	}
	return DEFAULT_CONTEXT_LIMIT;
}
