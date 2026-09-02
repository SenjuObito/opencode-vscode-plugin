import { act, renderHook } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheKeys, ServerToolsState } from '../types';
import { useToolsUpdate } from './useToolsUpdate';

const cacheKeys: CacheKeys = {
  SERVERS: 'test.servers',
  STATUS: 'test.status',
  TOOLS: 'test.tools',
  LAST_SERVER_ID: 'test.lastServerId',
};

function renderToolsHook() {
  const setServerTools = vi.fn() as unknown as Dispatch<SetStateAction<ServerToolsState>>;
  const onLog = vi.fn();
  return renderHook(() => useToolsUpdate({
    cacheKeys,
    setServerTools,
    onLog,
  }));
}

afterEach(() => {
  delete window.updateMcpServerTools;
});

describe('useToolsUpdate callback', () => {
  it('registers callback on mount and cleans up on unmount', () => {
    const hook = renderToolsHook();
    const callback = window.updateMcpServerTools;

    expect(callback).toBeTypeOf('function');

    hook.unmount();
    expect(window.updateMcpServerTools).toBeUndefined();
  });

  it('does not clear a callback replaced by a newer owner', () => {
    const firstHook = renderToolsHook();
    const replacement = vi.fn();
    window.updateMcpServerTools = replacement;

    firstHook.unmount();

    expect(window.updateMcpServerTools).toBe(replacement);
  });
});

describe('useToolsUpdate empty tool result', () => {
  it('logs a connected server with no tools as a warning', () => {
    const setServerTools = vi.fn() as unknown as Dispatch<SetStateAction<ServerToolsState>>;
    const onLog = vi.fn();
    const hook = renderHook(() => useToolsUpdate({
      cacheKeys,
      setServerTools,
      onLog,
    }));

    act(() => {
      window.updateMcpServerTools?.(JSON.stringify({
        serverId: 'empty-server',
        serverName: 'Empty server',
        tools: [],
        error: null,
      }));
    });

    expect(onLog).toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      undefined,
      'Empty server',
    );
    hook.unmount();
  });
});
