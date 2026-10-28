import { describe, expect, it } from 'vitest';
import { getModeAccentColor } from './modeColors';

describe('getModeAccentColor', () => {
  it('leaves the default build mode on the theme colours', () => {
    expect(getModeAccentColor('build')).toBeUndefined();
    expect(getModeAccentColor('default')).toBeUndefined();
    expect(getModeAccentColor('')).toBeUndefined();
    expect(getModeAccentColor(null)).toBeUndefined();
  });

  it('keeps the built-in plan orange and winui-dev blue', () => {
    expect(getModeAccentColor('plan')).toBe('#e07c24');
    expect(getModeAccentColor('winui-dev')).toBe('#3b9eff');
  });

  it('does not invent a colour for an undeclared custom mode', () => {
    expect(getModeAccentColor('reviewer')).toBeUndefined();
    expect(getModeAccentColor('my-agent')).toBeUndefined();
  });

  it('uses the colour the agent declares', () => {
    expect(getModeAccentColor('reviewer', '#2fb37a')).toBe('#2fb37a');
    expect(getModeAccentColor('winui-dev', '#2FB37A')).toBe('#2FB37A');
  });

  it('lets a declared colour override a built-in accent', () => {
    expect(getModeAccentColor('plan', '#123456')).toBe('#123456');
  });

  it('ignores a malformed declared colour and falls back to the built-in accent', () => {
    expect(getModeAccentColor('plan', 'orange')).toBe('#e07c24');
    expect(getModeAccentColor('plan', '#fff')).toBe('#e07c24');
    expect(getModeAccentColor('reviewer', 'rgb(1,2,3)')).toBeUndefined();
  });
});
