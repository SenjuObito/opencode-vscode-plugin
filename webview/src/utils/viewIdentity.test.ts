import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getViewId,
  isPromptHost,
  setPromptHostViewId,
  subscribePromptHost,
} from './viewIdentity';

describe('view identity / prompt host election', () => {
  beforeEach(() => {
    setPromptHostViewId(null);
    delete window.__VIEW_ID__;
  });

  afterEach(() => {
    setPromptHostViewId(null);
    delete window.__VIEW_ID__;
  });

  it('defaults to host in a single-view / legacy environment', () => {
    expect(getViewId()).toBe('');
    expect(isPromptHost()).toBe(true);
  });

  it('keeps hosting until the host has elected someone', () => {
    window.__VIEW_ID__ = 'panel-a';
    expect(isPromptHost()).toBe(true);
  });

  it('only the elected view renders prompts', () => {
    window.__VIEW_ID__ = 'panel-a';
    setPromptHostViewId('panel-b');

    expect(isPromptHost()).toBe(false);
    setPromptHostViewId('panel-a');
    expect(isPromptHost()).toBe(true);
  });

  it('notifies subscribers when the election changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePromptHost(listener);

    setPromptHostViewId('panel-a');
    setPromptHostViewId('panel-a');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setPromptHostViewId('panel-b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
