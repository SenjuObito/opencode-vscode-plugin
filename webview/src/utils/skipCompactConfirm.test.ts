// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SKIP_COMPACT_CONFIRM_EVENT,
  SKIP_COMPACT_CONFIRM_KEY,
  getSkipCompactConfirm,
  isCompactConfirmEnabled,
  setCompactConfirmEnabled,
  setSkipCompactConfirm,
  type SkipCompactConfirmChangedDetail,
} from './skipCompactConfirm';

describe('skipCompactConfirm', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getSkipCompactConfirm', () => {
    it('defaults to false when key is not present in localStorage', () => {
      expect(getSkipCompactConfirm()).toBe(false);
    });

    it('returns true when key is set to "true"', () => {
      localStorage.setItem(SKIP_COMPACT_CONFIRM_KEY, 'true');
      expect(getSkipCompactConfirm()).toBe(true);
    });

    it('returns false when key is set to "false" or anything else', () => {
      localStorage.setItem(SKIP_COMPACT_CONFIRM_KEY, 'false');
      expect(getSkipCompactConfirm()).toBe(false);
      localStorage.setItem(SKIP_COMPACT_CONFIRM_KEY, 'garbage');
      expect(getSkipCompactConfirm()).toBe(false);
    });
  });

  describe('setSkipCompactConfirm', () => {
    it('persists true to localStorage and dispatches CustomEvent with enabled: true', () => {
      const listener = vi.fn();
      window.addEventListener(SKIP_COMPACT_CONFIRM_EVENT, listener);

      setSkipCompactConfirm(true);

      expect(localStorage.getItem(SKIP_COMPACT_CONFIRM_KEY)).toBe('true');
      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as CustomEvent<SkipCompactConfirmChangedDetail>;
      expect(event.detail).toEqual({ enabled: true });

      window.removeEventListener(SKIP_COMPACT_CONFIRM_EVENT, listener);
    });

    it('persists false to localStorage and dispatches CustomEvent with enabled: false', () => {
      localStorage.setItem(SKIP_COMPACT_CONFIRM_KEY, 'true');
      const listener = vi.fn();
      window.addEventListener(SKIP_COMPACT_CONFIRM_EVENT, listener);

      setSkipCompactConfirm(false);

      expect(localStorage.getItem(SKIP_COMPACT_CONFIRM_KEY)).toBe('false');
      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as CustomEvent<SkipCompactConfirmChangedDetail>;
      expect(event.detail).toEqual({ enabled: false });

      window.removeEventListener(SKIP_COMPACT_CONFIRM_EVENT, listener);
    });
  });

  describe('isCompactConfirmEnabled / setCompactConfirmEnabled (positive semantics)', () => {
    it('is enabled (true) by default', () => {
      expect(isCompactConfirmEnabled()).toBe(true);
    });

    it('returns false when skip is true', () => {
      setSkipCompactConfirm(true);
      expect(isCompactConfirmEnabled()).toBe(false);
    });

    it('setCompactConfirmEnabled(false) causes skip to become true', () => {
      setCompactConfirmEnabled(false);
      expect(getSkipCompactConfirm()).toBe(true);
      expect(isCompactConfirmEnabled()).toBe(false);
    });

    it('setCompactConfirmEnabled(true) causes skip to become false', () => {
      setSkipCompactConfirm(true);
      setCompactConfirmEnabled(true);
      expect(getSkipCompactConfirm()).toBe(false);
      expect(isCompactConfirmEnabled()).toBe(true);
    });
  });
});
