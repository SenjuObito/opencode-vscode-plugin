/**
 * Font scaling — single entry point for applying the UI font scale.
 *
 * The scale lives in the `--font-scale` CSS variable on <html>; base.less
 * derives `#app` zoom and its inverse vw/vh size from it. Keeping every writer
 * on this helper guarantees the variable and any legacy inline `zoom` residue
 * on #app never disagree (a stale inline zoom overrides the stylesheet and
 * leaves the UI scaled without filling the viewport).
 */

/** Apply a font scale (e.g. '0.9', '1.4') to the whole app. */
export function applyFontScale(scale: string): void {
  document.documentElement.style.setProperty('--font-scale', scale);
  // 清理历史运行期可能残留的内联 zoom（旧版 JCEF 恢复机制的遗留），
  // 让样式表里的 zoom: var(--font-scale) 接管，避免新旧缩放不一致。
  document.getElementById('app')?.style.removeProperty('zoom');
}
