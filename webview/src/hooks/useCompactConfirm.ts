import { useCallback, useState } from 'react';

/**
 * Confirmation gate for the /compact session command. Compacting is
 * irreversible (opencode summarizes the conversation and prunes older
 * messages), so the actual send is deferred until the user confirms the
 * dialog. `requestCompact` only opens the dialog; nothing is sent until
 * `handleCompactConfirmed` runs `doCompact`.
 */
export function useCompactConfirm(doCompact: () => void) {
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);

  const requestCompact = useCallback(() => {
    setShowCompactConfirm(true);
  }, []);

  const handleCompactConfirmed = useCallback(() => {
    setShowCompactConfirm(false);
    doCompact();
  }, [doCompact]);

  const handleCancelCompact = useCallback(() => {
    setShowCompactConfirm(false);
  }, []);

  return { showCompactConfirm, requestCompact, handleCompactConfirmed, handleCancelCompact };
}
