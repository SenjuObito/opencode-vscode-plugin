import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { useResetAttachmentsOnSessionChange } from './useResetAttachmentsOnSessionChange.js';

describe('useResetAttachmentsOnSessionChange', () => {
  it('does not clear on the initial mount', () => {
    const clear = vi.fn();
    renderHook(() =>
      useResetAttachmentsOnSessionChange({
        currentSessionId: 'a',
        isControlled: false,
        clearInternalAttachments: clear,
      })
    );

    expect(clear).not.toHaveBeenCalled();
  });

  it('clears attachments when the session id changes (uncontrolled)', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: false,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'b' });

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear in controlled mode', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: true,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'b' });

    expect(clear).not.toHaveBeenCalled();
  });

  it('does nothing when the session id is unchanged across rerenders', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: false,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'a' });

    expect(clear).not.toHaveBeenCalled();
  });

  it('does NOT clear when the session change came from switching tabs', () => {
    // 切 tab 会话 id 必然变，但草稿属于「即将被激活的那个 tab」，
    // 由 tab 切换器在 selectTab 里恢复。这里清空会把它刚恢复的附件抹掉。
    const clear = vi.fn();
    let activeTabId = 'tab-1';
    (window as unknown as { __sessionTabsStore?: unknown }).__sessionTabsStore = {
      getActiveTabId: () => activeTabId,
    };

    try {
      const { rerender } = renderHook(
        ({ id }: { id: string | null }) =>
          useResetAttachmentsOnSessionChange({
            currentSessionId: id,
            isControlled: false,
            clearInternalAttachments: clear,
          }),
        { initialProps: { id: 'a' as string | null } }
      );

      activeTabId = 'tab-2';
      rerender({ id: 'b' });

      expect(clear).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { __sessionTabsStore?: unknown }).__sessionTabsStore;
    }
  });
});
