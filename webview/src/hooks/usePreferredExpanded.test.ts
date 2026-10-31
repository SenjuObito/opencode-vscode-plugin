// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePreferredExpanded } from './usePreferredExpanded';
import type { BooleanPreference } from '../utils/uiPreferences';
import {
  diffExpandedPreference,
  updateUiPreferences,
  applyHostUiPreferences,
} from '../utils/uiPreferences';

describe('usePreferredExpanded', () => {
  beforeEach(() => {
    localStorage.clear();
    applyHostUiPreferences({ diffExpandedByDefault: false });
  });

  it('tracks initial preference value', () => {
    const { result } = renderHook(() => usePreferredExpanded(diffExpandedPreference));
    expect(result.current[0]).toBe(false);
  });

  it('reactively updates when preference changes without manual override', () => {
    const { result } = renderHook(() => usePreferredExpanded(diffExpandedPreference));
    expect(result.current[0]).toBe(false);

    act(() => {
      updateUiPreferences({ diffExpandedByDefault: true });
    });

    expect(result.current[0]).toBe(true);

    act(() => {
      updateUiPreferences({ diffExpandedByDefault: false });
    });

    expect(result.current[0]).toBe(false);
  });

  it('allows manual override using boolean and functional updates', () => {
    const { result } = renderHook(() => usePreferredExpanded(diffExpandedPreference));
    expect(result.current[0]).toBe(false);

    act(() => {
      const [, setExpanded] = result.current;
      setExpanded(true);
    });

    expect(result.current[0]).toBe(true);

    act(() => {
      const [, setExpanded] = result.current;
      setExpanded((prev) => !prev);
    });

    expect(result.current[0]).toBe(false);
  });

  it('maintains manual override even if preference changes', () => {
    const { result } = renderHook(() => usePreferredExpanded(diffExpandedPreference));

    // Manually collapse
    act(() => {
      const [, setExpanded] = result.current;
      setExpanded(true);
    });
    expect(result.current[0]).toBe(true);

    // Global preference changes to false
    act(() => {
      updateUiPreferences({ diffExpandedByDefault: false });
    });

    // Manual override remains true
    expect(result.current[0]).toBe(true);
  });

  it('works with a custom mock preference object', () => {
    let value = true;
    const listeners = new Set<() => void>();
    const mockPreference: BooleanPreference = {
      get: () => value,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    const { result } = renderHook(() => usePreferredExpanded(mockPreference));
    expect(result.current[0]).toBe(true);

    act(() => {
      value = false;
      listeners.forEach((fn) => fn());
    });

    expect(result.current[0]).toBe(false);
  });
});
