import { useEffect, useMemo } from 'react';
import { REASONING_LEVELS, type ReasoningEffort, type ReasoningInfo } from './types';

export function isReasoningVisible(currentProvider?: string, selectedModel?: string): boolean {
  void currentProvider;
  void selectedModel;
  return true;
}

/**
 * Reasoning effort maps 1:1 to the opencode model variant (docs/models#variants).
 * Variants vary per model; the static low/medium/high list is the common subset.
 */
export function getAvailableReasoningLevels(
  currentProvider?: string,
  selectedModel?: string,
): ReasoningInfo[] {
  void currentProvider;
  void selectedModel;
  return REASONING_LEVELS;
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
): {
  isVisible: boolean;
  availableLevels: ReasoningInfo[];
  currentLevel: ReasoningInfo | undefined;
} {
  const isVisible = isReasoningVisible(currentProvider, selectedModel);
  const availableLevels = useMemo(
    () => getAvailableReasoningLevels(currentProvider, selectedModel),
    [currentProvider, selectedModel],
  );
  const currentLevel = resolveCurrentReasoningLevel(value, availableLevels);

  useEffect(() => {
    if (!isVisible || availableLevels.some((level) => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  return { isVisible, availableLevels, currentLevel };
}
