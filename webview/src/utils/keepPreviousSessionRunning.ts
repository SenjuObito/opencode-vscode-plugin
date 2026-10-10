/**
 * Persistence for the "keep previous session running after creating new session" preference.
 *
 * Storage: localStorage (per-machine, matches uiPreferences).
 *
 * Sync: dispatches a CustomEvent so the settings page toggle reacts immediately.
 */

import { updateUiPreferences, getUiPreferences } from './uiPreferences';

export const KEEP_PREVIOUS_SESSION_RUNNING_KEY = 'keepPreviousSessionRunningOnNew';
export const KEEP_PREVIOUS_SESSION_RUNNING_EVENT = 'keepPreviousSessionRunningChanged';

export interface KeepPreviousSessionRunningChangedDetail {
  enabled: boolean;
}

export function getKeepPreviousSessionRunningOnNew(): boolean {
  try {
    const raw = localStorage.getItem(KEEP_PREVIOUS_SESSION_RUNNING_KEY);
    if (raw !== null) {
      return raw === 'true';
    }
    return getUiPreferences().keepPreviousSessionRunningOnNew;
  } catch {
    return false;
  }
}

export function setKeepPreviousSessionRunningOnNew(value: boolean): void {
  try {
    localStorage.setItem(KEEP_PREVIOUS_SESSION_RUNNING_KEY, value ? 'true' : 'false');
  } catch (error) {
    console.warn('[keepPreviousSessionRunning] failed to persist:', error);
    return;
  }

  updateUiPreferences({ keepPreviousSessionRunningOnNew: value });

  const detail: KeepPreviousSessionRunningChangedDetail = { enabled: value };
  window.dispatchEvent(new CustomEvent(KEEP_PREVIOUS_SESSION_RUNNING_EVENT, { detail }));
}
