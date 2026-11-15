/**
 * Persistence for the "compact session" confirm dialog preference.
 *
 * Authority: the shared UI-preferences blob (`uiPreferences.ts`), which the
 * extension host persists in `globalState`. `localStorage` is only a mirror so
 * legacy direct readers keep working — it is never the source of truth, because
 * a webview rebuild (tab switch, reload, workspace change) can drop it.
 *
 * Sync: changing the value goes through `updateUiPreferences`, which dispatches
 * the field-level `skipCompactConfirmChanged` event for every listener — both
 * for local edits and for snapshots pushed back by the host, so two views no
 * longer disagree after one of them writes the setting.
 *
 * Two semantically-equivalent API pairs are exported:
 *   - getSkipCompactConfirm / setSkipCompactConfirm  (raw, "skip" semantics)
 *   - isCompactConfirmEnabled / setCompactConfirmEnabled (inverse, positive semantics)
 *
 * UI code should prefer the positive-semantics pair to avoid double negatives.
 * Internal call sites that gate "should we bypass the dialog?" stay with the raw pair.
 */

import {
  SKIP_COMPACT_CONFIRM_CHANGED_EVENT,
  getUiPreferences,
  updateUiPreferences,
} from './uiPreferences';

export const SKIP_COMPACT_CONFIRM_KEY = 'skipCompactConfirm';
/** @deprecated Event identity now lives with the preference blob; kept for callers. */
export const SKIP_COMPACT_CONFIRM_EVENT = SKIP_COMPACT_CONFIRM_CHANGED_EVENT;

export interface SkipCompactConfirmChangedDetail {
  enabled: boolean;
}

/**
 * Read the current preference. Defaults to `false` (i.e. keep showing the dialog)
 * so existing users see no behaviour change after upgrade.
 */
export function getSkipCompactConfirm(): boolean {
  return getUiPreferences().skipCompactConfirm;
}

/**
 * Persist the preference and notify subscribers.
 *
 * The shared store performs deduplication, so an unchanged value dispatches
 * nothing. That is intentional: the settings page and the dialog checkbox both
 * re-read the same authoritative value.
 */
export function setSkipCompactConfirm(value: boolean): void {
  updateUiPreferences({ skipCompactConfirm: value });
}

/**
 * Positive-semantics read: is the confirm dialog currently enabled (i.e. will it show)?
 *
 * Prefer this in UI code so that the toggle's "checked" state maps 1:1 to the
 * user-facing label without inversions.
 */
export function isCompactConfirmEnabled(): boolean {
  return !getSkipCompactConfirm();
}

/**
 * Positive-semantics write: enable (true) or disable (false) the confirm dialog.
 *
 * Internally inverts to the stored "skip" flag and delegates to
 * `setSkipCompactConfirm`, which handles persistence + event dispatch.
 */
export function setCompactConfirmEnabled(enabled: boolean): void {
  setSkipCompactConfirm(!enabled);
}
