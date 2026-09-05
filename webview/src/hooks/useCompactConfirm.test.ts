// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCompactConfirm } from './useCompactConfirm';

describe('useCompactConfirm', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useCompactConfirm(vi.fn()));

    expect(result.current.showCompactConfirm).toBe(false);
  });

  it('requestCompact opens the dialog without running doCompact', () => {
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });

    expect(result.current.showCompactConfirm).toBe(true);
    expect(doCompact).not.toHaveBeenCalled();
  });

  it('confirm runs doCompact exactly once and closes the dialog', () => {
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });
    act(() => {
      result.current.handleCompactConfirmed();
    });

    expect(doCompact).toHaveBeenCalledOnce();
    expect(result.current.showCompactConfirm).toBe(false);
  });

  it('cancel closes the dialog without running doCompact', () => {
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });
    act(() => {
      result.current.handleCancelCompact();
    });

    expect(doCompact).not.toHaveBeenCalled();
    expect(result.current.showCompactConfirm).toBe(false);
  });
});
