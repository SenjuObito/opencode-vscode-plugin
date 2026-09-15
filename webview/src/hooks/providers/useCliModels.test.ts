import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCliModelsCacheForTests, useCliModels } from './useCliModels';
import { OPENCODE_MODELS } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function emitCliModels(payload: unknown) {
  act(() => {
    window.setCliModels?.(JSON.stringify(payload));
  });
}

describe('useCliModels', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    __resetCliModelsCacheForTests();
  });

  afterEach(() => {
    delete window.setCliModels;
    __resetCliModelsCacheForTests();
    vi.useRealTimers();
  });

  it('fetches the opencode catalog when opencode provider is active', () => {
    renderHook(() => useCliModels('opencode'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'opencode');
  });

  it('falls back to the static OPENCODE_MODELS list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('opencode'));
    expect(result.current.cliModels).toEqual(OPENCODE_MODELS);
    expect(result.current.cliModelsLoading).toBe(true);
  });

  it('stores the opencode catalog and defaultModel from the backend payload', () => {
    const { result } = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      defaultModel: 'claude-3-7-sonnet',
      models: [{ id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', description: 'Claude 3.7' }],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', description: 'Claude 3.7' },
    ]);
    expect(result.current.cliDefaultModel).toBe('claude-3-7-sonnet');
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('carries each model context window through the catalog payload', () => {
    const { result } = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      models: [
        { id: 'deepseek/deepseek-v4-pro', label: 'Deepseek-V4-Pro', contextWindow: 1_000_000 },
        { id: 'opencode/big-pickle', label: 'Big-Pickle', contextWindow: 200_000 },
      ],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'deepseek/deepseek-v4-pro', label: 'Deepseek-V4-Pro', contextWindow: 1_000_000 },
      { id: 'opencode/big-pickle', label: 'Big-Pickle', contextWindow: 200_000 },
    ]);
  });

  it('drops a missing or bogus context window instead of storing nonsense', () => {
    const { result } = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      models: [
        { id: 'no-limit', label: 'No Limit' },
        { id: 'zero-limit', label: 'Zero', contextWindow: 0 },
        { id: 'negative-limit', label: 'Negative', contextWindow: -5 },
        { id: 'nan-limit', label: 'NaN', contextWindow: 'nope' },
        { id: 'fractional-limit', label: 'Fractional', contextWindow: 1.5 },
      ],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'no-limit', label: 'No Limit' },
      { id: 'zero-limit', label: 'Zero' },
      { id: 'negative-limit', label: 'Negative' },
      { id: 'nan-limit', label: 'NaN' },
      { id: 'fractional-limit', label: 'Fractional' },
    ]);
  });

  it('times out into an error state and falls back to static models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('opencode'));
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.cliModels).toEqual(OPENCODE_MODELS);
  });

  it('reuses the module cache on remount so history→chat does not re-fetch', () => {
    const first = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      defaultModel: 'openai/gpt-5',
      models: [
        { id: 'opencode-default', label: 'OpenCode Default' },
        { id: 'openai/gpt-5', label: 'gpt-5' },
      ],
    });
    expect(first.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    first.unmount();

    sendBridgeEventMock.mockClear();
    const second = renderHook(() => useCliModels('opencode'));
    // Cache already has entries — no bridge round-trip on remount.
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(second.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    expect(second.result.current.cliCatalogHasEntries).toBe(true);
    expect(second.result.current.cliDefaultModel).toBe('openai/gpt-5');
    expect(second.result.current.cliModelsLoading).toBe(false);
  });
});

