import { useCallback, useState, useSyncExternalStore } from 'react';
import type { BooleanPreference } from '../utils/uiPreferences';

/**
 * Hook to manage boolean expanded state with preference-driven default.
 * Subscribes to the underlying preference store via useSyncExternalStore.
 * Allows local override via setExpanded, supporting functional updates.
 */
export function usePreferredExpanded(
  preference: BooleanPreference,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const preferred = useSyncExternalStore(preference.subscribe, preference.get);
  const [override, setOverride] = useState<boolean | undefined>(undefined);

  const expanded = override ?? preferred;

  const setExpanded: React.Dispatch<React.SetStateAction<boolean>> = useCallback(
    (action) => {
      setOverride((prevOverride) => {
        const currentEffective = prevOverride ?? preference.get();
        return typeof action === 'function' ? action(currentEffective) : action;
      });
    },
    [preference],
  );

  return [expanded, setExpanded];
}
