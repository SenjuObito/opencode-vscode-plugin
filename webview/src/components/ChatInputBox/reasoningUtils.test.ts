import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReasoningEffortGuard } from './reasoningUtils';

/**
 * 回归：`useReasoningEffortGuard` 在“选择器不显示”时必须把值复位成 'default'。
 *
 * 这条曾经丢过：本仓一度自己写了一份 guard，隐藏时直接 return，于是不支持的模型
 * 仍带着上一个模型的 effort 发出去（idea 的实现在这里会 onChange('default')）。
 */
describe('useReasoningEffortGuard', () => {
  it('模型不支持任何档位时隐藏选择器，并把值复位为 default', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useReasoningEffortGuard('high', onChange, 'mimo-v2.6-flash-free', 'opencode', undefined),
    );

    expect(result.current.isVisible).toBe(false);
    expect(result.current.availableLevels).toEqual([]);
    expect(onChange).toHaveBeenCalledWith('default');
  });

  it('档位列表为空数组时同样视为不支持', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useReasoningEffortGuard('high', onChange, 'deepseek', 'opencode', []),
    );

    expect(result.current.isVisible).toBe(false);
    expect(onChange).toHaveBeenCalledWith('default');
  });

  it('当前值不在模型档位里时回落到第一个档位', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useReasoningEffortGuard('xhigh', onChange, 'glm', 'opencode', ['low', 'high']),
    );

    expect(result.current.isVisible).toBe(true);
    expect(result.current.availableLevels.map((l) => l.id)).toEqual(['low', 'high']);
    expect(onChange).toHaveBeenCalledWith('low');
  });

  it('值本身可用时不打扰调用方', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useReasoningEffortGuard('high', onChange, 'glm', 'opencode', ['low', 'high']),
    );

    expect(result.current.currentLevel?.id).toBe('high');
    expect(onChange).not.toHaveBeenCalled();
  });
});
