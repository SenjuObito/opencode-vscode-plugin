import type { ModelInfo } from './types';

export interface ResolveProviderModelsInput {
  provider?: string;
  /** Dynamic catalog from useCliModels (may be static fallback when empty). */
  cliModels: ModelInfo[];
  /** True only when the backend returned real catalog entries. */
  cliCatalogHasEntries?: boolean;
}

/**
 * Single source of truth for the model picker list — used by:
 *  - main chat toolbar (ButtonArea)
 *  - Prompt Enhancer settings
 *  - Commit AI settings
 */
export function resolveProviderModels({
  cliModels,
}: ResolveProviderModelsInput): ModelInfo[] {
  return cliModels;
}

