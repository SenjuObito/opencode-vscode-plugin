/*
 * Model context limits — port of cc-gui `SettingsHandler.getModelContextLimit`.
 * Used to compute the context-usage percentage in the toolbar TokenCircle.
 *
 * Real provider metadata wins over the pinned table: the opencode model catalog
 * reports each model's models.dev `limit.context`, which is the only correct
 * source for models the table below has never heard of (deepseek-v4-pro is 1M,
 * not the pinned 200k default). The table stays as the offline fallback for when
 * the catalog is still cold or a model is missing from it.
 */
import { getCatalogContextWindow } from './ModelContextWindowCatalog';

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

/**
 * Resolve a model's context window, preferring real provider metadata over the
 * pinned table.
 *
 * Ids carrying an explicit capacity suffix (`model[1m]`) deliberately miss the
 * catalog — its keys never contain a suffix — and fall through to the parser
 * below, so an explicit capacity still wins over the catalog's bare-id value.
 */
export function getModelContextLimit(model: string | null | undefined): number {
	const fromCatalog = getCatalogContextWindow(model);
	return fromCatalog !== undefined ? fromCatalog : getHardcodedModelContextLimit(model);
}

/** The offline table: bracketed suffix, pinned ids, then the 200k default. */
function getHardcodedModelContextLimit(model: string | null | undefined): number {
	if (!model) {
		return DEFAULT_CONTEXT_LIMIT;
	}
	const trimmed = model.trim();

	// 1. Explicit bracketed capacity suffix, e.g. "claude-sonnet-4-7 [1m]" or "model[200k]"
	const match = /\s*\[([0-9.]+)([kKmM])\]\s*$/.exec(trimmed);
	if (match && match[1] && match[2]) {
		const val = parseFloat(match[1]);
		const unit = match[2].toLowerCase();
		if (!Number.isNaN(val) && val > 0) {
			return Math.round(unit === 'm' ? val * 1_000_000 : val * 1_000);
		}
	}

	// 2. Exact match on full string
	if (KNOWN_LIMITS[trimmed] != null) {
		return KNOWN_LIMITS[trimmed];
	}

	// 3. Strip provider prefix if present (e.g. "anthropic/claude-3-7-sonnet" -> "claude-3-7-sonnet")
	const slashIdx = trimmed.indexOf('/');
	const bareModel = slashIdx >= 0 ? trimmed.substring(slashIdx + 1) : trimmed;
	if (KNOWN_LIMITS[bareModel] != null) {
		return KNOWN_LIMITS[bareModel];
	}

	// 4. Prefix match (e.g. "claude-3-7-sonnet-20250219")
	for (const [name, limit] of Object.entries(KNOWN_LIMITS)) {
		if (name !== 'default' && (trimmed.startsWith(name) || bareModel.startsWith(name))) {
			return limit;
		}
	}

	return DEFAULT_CONTEXT_LIMIT;
}
