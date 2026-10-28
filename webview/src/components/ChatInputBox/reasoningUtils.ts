import { useEffect, useMemo } from 'react';
import {
  REASONING_LEVELS,
  getAvailableReasoningLevels as listReasoningLevels,
  getRecommendedReasoningEffort,
  type ReasoningEffort,
  type ReasoningInfo,
} from './types';

/**
 * 推理力度（opencode 的 model variants）的**单一**判定实现。
 *
 * 之前这里另有一份「静态 low/medium/high」的副本，而 `ReasoningSelect` 又自己
 * 内联了一遍回落逻辑，两边对「不支持时怎么办」的答案不一致（§10.6 的缺口）。
 * 现在只有这一份：
 *   - 档位来源：`types.getAvailableReasoningLevels(provider, model, variants)`
 *   - 可见性：一个档位都没有就隐藏选择器
 *   - 回落：当前值不在档位里 → 推荐档 → 第一个档
 */
export function isReasoningVisible(availableLevels: ReasoningInfo[]): boolean {
  return availableLevels.length > 0;
}

export function resolveCurrentReasoningLevel(
  value: ReasoningEffort,
  availableLevels: ReasoningInfo[],
  recommended?: ReasoningEffort,
): ReasoningInfo | undefined {
  return availableLevels.find((level) => level.id === value)
    || (recommended ? availableLevels.find((level) => level.id === recommended) : undefined)
    || availableLevels[0];
}

/** 纯函数版本（测试/非组件场景）：给定档位算出可用的推荐档。 */
export function resolveRecommendedEffort(availableLevels: ReasoningInfo[]): ReasoningEffort | undefined {
  return getRecommendedReasoningEffort(availableLevels.map((level) => level.id));
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
    () => listReasoningLevels(currentProvider, selectedModel, modelVariants),
    [currentProvider, selectedModel, modelVariants],
  );
  const recommended = useMemo(() => resolveRecommendedEffort(availableLevels), [availableLevels]);
  const isVisible = isReasoningVisible(availableLevels);
  const currentLevel = resolveCurrentReasoningLevel(value, availableLevels, recommended);

  useEffect(() => {
    if (!isVisible) {
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

/** 静态档位表（下拉文案的兜底来源）。 */
export { REASONING_LEVELS };
