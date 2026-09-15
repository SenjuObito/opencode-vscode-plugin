/**
 * ModelContextWindowCatalog — runtime catalog of the context windows reported
 * by the opencode model list.
 *
 * The opencode daemon sources each model's total context window from models.dev
 * (`limit.context`) — the authoritative number for models such as
 * `deepseek/deepseek-v4-pro` (1M) that the hardcoded {@link getModelContextLimit}
 * table does not know about. That field used to be dropped while building the
 * model list payload, so every unlisted model fell back to a 200k guess and the
 * toolbar usage ring showed the wrong denominator.
 *
 * A context window is an intrinsic property of a model id rather than of a
 * workspace or panel, so the catalog is module-scoped and keyed by model id. It
 * is filled from every model-list payload {@link CliModelsHandler} sees —
 * cached or freshly fetched — and consulted before any hardcoded fallback.
 *
 * Updates only ever merge: a payload without limit metadata (the legacy
 * `opencode models` stdout fallback, or a cache entry written by an older
 * build) must not erase what a richer payload already taught us.
 */

const contextWindows = new Map<string, number>();

/**
 * Merge every context window carried by a model-list payload.
 *
 * @param payload the `getModels` payload (`{ models: [...] }`)
 * @returns true when at least one new or different window was learned, so
 *   callers can republish a usage snapshot computed before the catalog was warm
 */
export function updateModelContextWindows(payload: unknown): boolean {
	const models = (payload as { models?: unknown })?.models;
	if (!Array.isArray(models)) {
		return false;
	}

	let changed = false;
	for (const entry of models) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const record = entry as { id?: unknown; contextWindow?: unknown };
		const id = typeof record.id === 'string' ? record.id.trim() : '';
		const contextWindow = Number(record.contextWindow);
		// A token count is a positive integer; anything else is upstream garbage
		// and must not be silently rounded into the catalog.
		if (!id || !Number.isInteger(contextWindow) || contextWindow <= 0) {
			continue;
		}
		changed = registerContextWindow(id, contextWindow) || changed;
	}
	return changed;
}

/**
 * Resolve a context window by model id.
 *
 * Both the fully qualified `provider/model` form and the bare model id are
 * honoured, because opencode hands the plugin `provider/model` while other call
 * sites may hold either form.
 *
 * Ids carrying an explicit capacity suffix (for example `claude-sonnet-5[1m]`)
 * deliberately miss here and fall through to the suffix parser, so an explicit
 * user-chosen capacity always wins.
 *
 * @returns the known context window, or undefined when the catalog cannot answer
 */
export function getCatalogContextWindow(model: string | null | undefined): number | undefined {
	if (typeof model !== 'string') {
		return undefined;
	}
	const trimmed = model.trim();
	if (trimmed === '') {
		return undefined;
	}

	const exact = contextWindows.get(trimmed);
	if (exact !== undefined) {
		return exact;
	}
	const slashIdx = trimmed.indexOf('/');
	if (slashIdx >= 0 && slashIdx < trimmed.length - 1) {
		return contextWindows.get(trimmed.substring(slashIdx + 1));
	}
	return undefined;
}

/** Test-only: drop every remembered window. */
export function __resetModelContextWindowCatalogForTests(): void {
	contextWindows.clear();
}

/**
 * Record one window under its qualified id, plus under its bare model id when
 * nobody claimed that bare name yet (bare ids are ambiguous across providers,
 * so first writer wins).
 *
 * @returns true when a previously unknown value was stored
 */
function registerContextWindow(modelId: string, contextWindow: number): boolean {
	let changed = putIfChanged(modelId, contextWindow);

	const slashIdx = modelId.indexOf('/');
	if (slashIdx >= 0 && slashIdx < modelId.length - 1) {
		const bare = modelId.substring(slashIdx + 1);
		if (!contextWindows.has(bare)) {
			changed = putIfChanged(bare, contextWindow) || changed;
		}
	}
	return changed;
}

function putIfChanged(key: string, contextWindow: number): boolean {
	const previous = contextWindows.get(key);
	contextWindows.set(key, contextWindow);
	return previous !== contextWindow;
}
