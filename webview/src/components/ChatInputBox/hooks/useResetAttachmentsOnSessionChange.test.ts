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
});
