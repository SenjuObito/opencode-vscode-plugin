import { describe, expect, it, beforeEach } from 'vitest';
import { applyFontSizeLevel, normalizeFontSizeLevel } from './fontScale';

describe('applyFontSizeLevel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app" style="zoom: 0.9"></div>';
    document.documentElement.removeAttribute('data-font-size-level');
  });

  it('writes the level attribute so CSS owns the scale', () => {
    applyFontSizeLevel(6);
    expect(document.documentElement.getAttribute('data-font-size-level')).toBe('6');
  });

  it('returns the normalised level', () => {
    expect(applyFontSizeLevel(4)).toBe(4);
    expect(applyFontSizeLevel(99)).toBe(6);
    expect(applyFontSizeLevel(0)).toBe(1);
  });

  it('clears stale inline zoom on #app so the stylesheet rule takes over', () => {
    const app = document.getElementById('app') as HTMLElement;
    expect(app.style.zoom).toBe('0.9');

    applyFontSizeLevel(5);

    expect(app.style.zoom).toBe('');
  });
});

describe('normalizeFontSizeLevel', () => {
  it('clamps and truncates numbers', () => {
    expect(normalizeFontSizeLevel(3.9)).toBe(3);
    expect(normalizeFontSizeLevel(-2)).toBe(1);
    expect(normalizeFontSizeLevel(7)).toBe(6);
  });

  it('falls back to the default for junk input', () => {
    expect(normalizeFontSizeLevel(undefined)).toBe(2);
    expect(normalizeFontSizeLevel(null)).toBe(2);
    expect(normalizeFontSizeLevel('')).toBe(2);
    expect(normalizeFontSizeLevel('nope')).toBe(2);
    expect(normalizeFontSizeLevel(Number.NaN)).toBe(2);
  });

  it('accepts numeric strings (host payloads may arrive stringified)', () => {
    expect(normalizeFontSizeLevel('5')).toBe(5);
  });
});
