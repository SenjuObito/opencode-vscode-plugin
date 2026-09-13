import { useCallback, useState } from 'react';
import { getSkipCompactConfirm, setSkipCompactConfirm } from '../utils/skipCompactConfirm';

/**
 * Confirmation gate for the /compact session command. Compacting is
 * irreversible (opencode summarizes the conversation and prunes older
 * messages), so the actual send is deferred until the user confirms the
 * dialog (unless the user chose "don't ask again" or disabled it in settings).
 * `requestCompact` opens the dialog if confirmation is enabled; otherwise it
 * runs `doCompact` immediately.
 */
export function useCompactConfirm(doCompact: () => void) {
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);

  const requestCompact = useCallback(() => {
    if (getSkipCompactConfirm()) {
      doCompact();
      return;
    }
    setShowCompactConfirm(true);
  }, [doCompact]);

  const handleCompactConfirmed = useCallback((skipAgain?: boolean) => {
    if (skipAgain) {
      setSkipCompactConfirm(true);
    }
    setShowCompactConfirm(false);
    doCompact();
  }, [doCompact]);

  const handleCancelCompact = useCallback(() => {
    setShowCompactConfirm(false);
  }, []);

  return { showCompactConfirm, requestCompact, handleCompactConfirmed, handleCancelCompact };
}

