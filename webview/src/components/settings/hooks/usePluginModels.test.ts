import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../../../types/provider';
import { usePluginModels } from './usePluginModels';

describe('usePluginModels', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists custom pricing locally for Claude models', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        {
          id: 'vendor/custom-claude',
          label: 'Custom Claude',
          contextWindowTokens: 500_000,
          pricing: {
            inputCostPer1M: 0.2,
            outputCostPer1M: 0.8,
            cacheWriteCostPer1M: 0.25,
            cacheReadCostPer1M: 0.02,
          },
        },
      ]);
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) || '[]')).toEqual([
      {
        id: 'vendor/custom-claude',
        label: 'Custom Claude',
        pricing: {
          inputCostPer1M: 0.2,
          outputCostPer1M: 0.8,
          cacheWriteCostPer1M: 0.25,
          cacheReadCostPer1M: 0.02,
        },
      },
    ]);
  });

  it('drops stale context metadata when reading Claude custom models', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS, JSON.stringify([{
      id: 'vendor/custom-claude',
      label: 'Custom Claude',
      contextWindowTokens: 500_000,
    }]));

    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    expect(result.current.models).toEqual([{
      id: 'vendor/custom-claude',
      label: 'Custom Claude',
    }]);
  });

  it('filters invalid pricing before persisting Codex models', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        { id: 'valid-codex', label: 'Valid Codex', pricing: { inputCostPer1M: 0.1 } },
        { id: 'invalid-codex', label: 'Invalid Codex', pricing: { inputCostPer1M: -1 } },
      ]);
    });

    const expectedModels = [
      { id: 'valid-codex', label: 'Valid Codex', pricing: { inputCostPer1M: 0.1 } },
    ];

    expect(result.current.models).toEqual(expectedModels);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS) || '[]')).toEqual(expectedModels);
  });

  it('persists a custom context window alongside pricing', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([{
        id: 'vendor/context-model',
        label: 'Context Model',
        contextWindowTokens: 500_000,
        pricing: { inputCostPer1M: 0.1 },
      }]);
    });

    const expectedModels = [{
      id: 'vendor/context-model',
      label: 'Context Model',
      contextWindowTokens: 500_000,
      pricing: { inputCostPer1M: 0.1 },
    }];

    expect(result.current.models).toEqual(expectedModels);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS) || '[]')).toEqual(expectedModels);
  });
});
