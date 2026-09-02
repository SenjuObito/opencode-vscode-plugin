import { describe, expect, it, beforeEach } from 'vitest';
import { applyFontScale } from './fontScale';

describe('applyFontScale', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app" style="zoom: 0.9"></div>';
    document.documentElement.style.removeProperty('--font-scale');
  });

  it('sets the --font-scale variable on the document element', () => {
    applyFontScale('1.4');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
  });

  it('clears stale inline zoom on #app so the stylesheet var takes over', () => {
    const app = document.getElementById('app') as HTMLElement;
    expect(app.style.zoom).toBe('0.9');

    applyFontScale('1.4');

    expect(app.style.zoom).toBe('');
  });

  it('is a no-op for #app when no inline zoom residue exists', () => {
    const app = document.getElementById('app') as HTMLElement;
    app.style.removeProperty('zoom');

    applyFontScale('0.8');

    expect(app.style.zoom).toBe('');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('0.8');
  });
});
