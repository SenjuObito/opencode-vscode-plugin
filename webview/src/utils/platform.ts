/**
 * Platform detection + keyboard modifier display helpers.
 *
 * Detection prefers `navigator.userAgentData.platform` (modern, non-deprecated)
 * and falls back to `userAgent` sniffing — same strategy as App.tsx find
 * shortcut. `navigator.platform` is intentionally not used (deprecated,
 * inconsistent inside webview).
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.userAgent ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Display symbol for the Control key.
 * Apple platforms use the ⌃ glyph; Windows/Linux have no standard glyph so
 * the "Ctrl" text label is used.
 */
export function controlKeySymbol(): string {
  return isMacPlatform() ? '⌃' : 'Ctrl';
}
