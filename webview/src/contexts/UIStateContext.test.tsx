import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { UIStateProvider, useUIState } from './UIStateContext';

describe('UIStateContext Toast management', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <UIStateProvider>{children}</UIStateProvider>
  );

  it('adds a toast and deduplicates identical active toasts', () => {
    const { result } = renderHook(() => useUIState(), { wrapper });

    act(() => {
      result.current.addToast('Error: Rate limit exceeded', 'error');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Error: Rate limit exceeded');
    expect(result.current.toasts[0].type).toBe('error');

    // Calling again with the same message and type should not add a duplicate toast
    act(() => {
      result.current.addToast('Error: Rate limit exceeded', 'error');
    });

    expect(result.current.toasts).toHaveLength(1);

    // Different message should add a new toast
    act(() => {
      result.current.addToast('Another notification', 'info');
    });

    expect(result.current.toasts).toHaveLength(2);
  });

  it('allows dismissing and clearing toasts', () => {
    const { result } = renderHook(() => useUIState(), { wrapper });

    act(() => {
      result.current.addToast('Toast 1', 'info');
      result.current.addToast('Toast 2', 'warning');
    });

    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      result.current.dismissToast(result.current.toasts[0].id);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Toast 2');

    act(() => {
      result.current.clearToasts();
    });

    expect(result.current.toasts).toHaveLength(0);
  });
});
