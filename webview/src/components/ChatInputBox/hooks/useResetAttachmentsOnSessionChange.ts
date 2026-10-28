import { useEffect, useRef } from 'react';

import { getTabStore } from '../../../store/tabStore';

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
 *
 * **Switching tabs is not a session change.** Each tab keeps its own draft, and
 * the tab switcher restores the incoming tab's attachments right after the
 * switch. Clearing here would wipe the attachments that were just restored, so
 * a tab-id change is detected and skipped. Loading a different session *into the
 * same tab* still clears — that draft belongs to the previous conversation.
 */
export function useResetAttachmentsOnSessionChange({
  currentSessionId,
  isControlled,
  clearInternalAttachments,
}: UseResetAttachmentsOnSessionChangeOptions): void {
  const prevSessionIdRef = useRef(currentSessionId);
  const prevTabIdRef = useRef<string | null>(getTabStore().getActiveTabId());

  useEffect(() => {
    if (prevSessionIdRef.current === currentSessionId) return;
    prevSessionIdRef.current = currentSessionId;

    const activeTabId = getTabStore().getActiveTabId();
    const tabChanged = prevTabIdRef.current !== activeTabId;
    prevTabIdRef.current = activeTabId;
    if (tabChanged) {
      // Handled by the tab switcher's draft restore.
      return;
    }

    if (!isControlled) {
      clearInternalAttachments();
    }
  }, [currentSessionId, isControlled, clearInternalAttachments]);
}
