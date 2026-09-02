import { useEffect, useRef } from 'react';

export interface UseResetAttachmentsOnSessionChangeOptions {
  /** Active session id from SessionContext; null when there is no session/provider. */
  currentSessionId: string | null;
  /** Whether attachments are externally controlled (the parent owns clearing). */
  isControlled: boolean;
  /** Clears the internal attachment list and its persisted draft. */
  clearInternalAttachments: () => void;
}

/**
 * Resets draft attachments when the active session changes so they don't drift
 * into a new conversation.
 *
 * Skips the initial mount (no spurious clear on first render). In controlled
 * mode the parent owns the attachment list, so this hook is a no-op.
 */
export function useResetAttachmentsOnSessionChange({
  currentSessionId,
  isControlled,
  clearInternalAttachments,
}: UseResetAttachmentsOnSessionChangeOptions): void {
  const prevSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === currentSessionId) return;
    prevSessionIdRef.current = currentSessionId;
    if (!isControlled) {
      clearInternalAttachments();
    }
  }, [currentSessionId, isControlled, clearInternalAttachments]);
}
