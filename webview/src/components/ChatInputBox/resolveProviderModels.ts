import type { ModelInfo } from './types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
} from './types';
import { buildCodexModelList } from './codexModelList';
import {
  applyClaudeModelMapping,
  type ClaudeModelMapping,
} from '../../utils/claudeModelMapping';

export interface ResolveProviderModelsInput {
  provider: string;
  /** Dynamic catalog from useCliModels (may be static fallback when empty). */
  cliModels: ModelInfo[];
  /**
   * True only when the backend returned real catalog entries.
   * When false, cliModels is the static fallback and must not replace built-ins
   * for Codex (see buildCodexModelList).
   */
  cliCatalogHasEntries?: boolean;
  claudeCustomModels?: ModelInfo[];
  codexCustomModels?: ModelInfo[];
  claudeMapping?: ClaudeModelMapping | null;
}

/**
 * Customs first; collapse duplicate *labels* (several built-in slots mapped
 * to the same real model name) the same way the settings panel used to.
 */
function mergeCustomsFirst(customs: ModelInfo[], models: ModelInfo[]): ModelInfo[] {
  if (customs.length === 0) {
    return models;
  }

  const merged = [...customs, ...models];
  const seenLabels = new Set<string>();
  const seenIds = new Set<string>();
  return merged.filter((m) => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    const key = m.label.trim().toLowerCase();
    if (key && seenLabels.has(key)) return false;
    if (key) seenLabels.add(key);
    return true;
  });
}

/**
 * Single source of truth for the model picker list — used by:
 *  - main chat toolbar (ButtonArea)
 *  - Prompt Enhancer settings
 *  - Commit AI settings
 *
 * Keep all three UIs in lockstep so users never see divergent catalogs.
 */
export function resolveProviderModels({
  provider,
  cliModels,
  cliCatalogHasEntries = false,
  claudeCustomModels = [],
  codexCustomModels = [],
  claudeMapping = null,
}: ResolveProviderModelsInput): ModelInfo[] {
  if (provider === 'codex') {
    const catalogModels = cliCatalogHasEntries ? cliModels : [];
    return buildCodexModelList(catalogModels, codexCustomModels, CODEX_MODELS);
  }

  if (provider === 'opencode') {
    return mergeCustomsFirst(claudeCustomModels, cliModels);
  }

  // Claude (default)
  let builtIns: ModelInfo[] = CLAUDE_MODELS;
  if (claudeMapping && Object.keys(claudeMapping).length > 0) {
    try {
      builtIns = CLAUDE_MODELS.map((m) => applyClaudeModelMapping(m, claudeMapping));
    } catch {
      builtIns = CLAUDE_MODELS;
    }
  }

  return mergeCustomsFirst(claudeCustomModels, builtIns);
}
