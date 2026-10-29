import { useEffect, useMemo } from 'react';
import {
  getAvailableReasoningLevels,
  type ReasoningEffort,
  type ReasoningInfo,
} from './types';

/**
 * Re-exported from `types.ts` so there is exactly one implementation of the
 * variant filtering. A local copy used to live here with a two-argument
 * signature, which silently ignored the `modelVariants` argument and kept
 * returning every level — the reason the selector never respected a model's
 * catalog.
 */
export { getAvailableReasoningLevels } from './types';

export function isReasoningVisible(
  currentProvider?: string,
  selectedModel?: string,
  modelVariants?: string[],
): boolean {
  return getAvailableReasoningLevels(currentProvider, selectedModel, modelVariants).length > 0;
}

export function resolveCurrentReasoningLevel(
  value: ReasoningEffort,
  availableLevels: ReasoningInfo[],
): ReasoningInfo | undefined {
  return availableLevels.find((level) => level.id === value)
    || availableLevels[0];
}

export function useReasoningEffortGuard(
  value: ReasoningEffort,
  onChange: (effort: ReasoningEffort) => void,
  selectedModel?: string,
  currentProvider?: string,
  modelVariants?: string[],
): {
  isVisible: boolean;
  availableLevels: ReasoningInfo[];
  currentLevel: ReasoningInfo | undefined;
} {
  const availableLevels = useMemo(
    () => getAvailableReasoningLevels(currentProvider, selectedModel, modelVariants),
    [currentProvider, selectedModel, modelVariants],
  );
  const isVisible = availableLevels.length > 0;
  const currentLevel = resolveCurrentReasoningLevel(value, availableLevels);

  useEffect(() => {
    if (!isVisible) {
      if (value !== 'default') {
        onChange('default');
      }
      return;
    }
    if (availableLevels.some((level) => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  return { isVisible, availableLevels, currentLevel };
}
