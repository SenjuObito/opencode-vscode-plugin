// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompactConfirm } from './useCompactConfirm';
import {
  getSkipCompactConfirm,
  setSkipCompactConfirm,
} from '../utils/skipCompactConfirm';

describe('useCompactConfirm', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts closed', () => {
    const { result } = renderHook(() => useCompactConfirm(vi.fn()));

    expect(result.current.showCompactConfirm).toBe(false);
  });

  it('requestCompact opens the dialog without running doCompact when skip is false', () => {
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });

    expect(result.current.showCompactConfirm).toBe(true);
    expect(doCompact).not.toHaveBeenCalled();
  });

  it('requestCompact directly runs doCompact when skip is true', () => {
    setSkipCompactConfirm(true);
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });

    expect(result.current.showCompactConfirm).toBe(false);
    expect(doCompact).toHaveBeenCalledOnce();
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
    expect(getSkipCompactConfirm()).toBe(false);
  });

  it('confirm with skipAgain=true persists skip preference to true', () => {
    const doCompact = vi.fn();
    const { result } = renderHook(() => useCompactConfirm(doCompact));

    act(() => {
      result.current.requestCompact();
    });
    act(() => {
      result.current.handleCompactConfirmed(true);
    });

    expect(doCompact).toHaveBeenCalledOnce();
    expect(result.current.showCompactConfirm).toBe(false);
    expect(getSkipCompactConfirm()).toBe(true);
  });

  it('cancel closes the dialog without running doCompact and does not persist skip', () => {
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
    expect(getSkipCompactConfirm()).toBe(false);
  });
});

