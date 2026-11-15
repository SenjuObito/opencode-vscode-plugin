/**
 * Font scaling — single entry point for applying the UI font level.
 *
 * The level (1..6) is written to `<html data-font-size-level="N">`; the actual
 * zoom ratio lives in exactly one place, the `base.less` rules keyed by that
 * attribute (`:root { --font-scale: … }` + `html[data-font-size-level='N']`).
 * Host bootstrap scripts therefore only inject the persisted level, never a
 * duplicated level→ratio table.
 *
 * `fontScale.ts` also owns level normalisation so the settings page, the
 * bootstrap path and the persisted preferences all clamp identically.
 */

/** Supported font-size levels, from smallest to largest. */
export const FONT_SIZE_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** 90% — kept in sync with the `:root` default in base.less. */
export const DEFAULT_FONT_SIZE_LEVEL = 2;

/** Clamp an arbitrary value to a valid 1..6 level. */
export function normalizeFontSizeLevel(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_FONT_SIZE_LEVEL;
  }
  return Math.min(6, Math.max(1, parsed));
}

/**
 * Apply a font-size level to the whole app.
 *
 * Only the level attribute is written; the scale itself is CSS-owned. Any
 * legacy inline `zoom` on #app (older JCEF recovery path) is cleared so the
 * stylesheet rule is the single source of truth.
 */
export function applyFontSizeLevel(level: unknown): number {
  const normalized = normalizeFontSizeLevel(level);
  document.documentElement.setAttribute('data-font-size-level', String(normalized));
  document.getElementById('app')?.style.removeProperty('zoom');
  return normalized;
}
