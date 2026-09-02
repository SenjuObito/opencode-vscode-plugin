import { useCallback, useEffect, useState} from 'react';
import { getAppViewport } from '../utils/viewport';

/** Gap (CSS px) kept between the dialog bottom edge and the input area top. */
const DOCK_GAP_PX = 8;

/**
 * Bottom offset (CSS px) for a `position: fixed` overlay so that it docks
 * right ABOVE the chat input area instead of the raw viewport bottom.
 *
 * The permission / ask-user-question dialogs are full-width bottom bars
 * (`.permission-dialog-overlay`). With plain `bottom: 0` they slide over the
 * input box because the input area lives at the end of the normal flow. This
 * hook measures the input area's top edge and converts it into a viewport
 * `bottom` value, reusing the same CSS-zoom compensation ScrollControl uses
 * (`fixedPosDivisor`) so it stays correct on zoomed `#app` builds.
 *
 * Returns 0 while the input area is hidden (settings/history view keeps the
 * chat tree mounted with `display: none`, collapsing its rect to zero) —
 * falling back to the previous page-bottom dock.
 */
export function useInputAreaBottomOffset(
  inputAreaRef: React.RefObject<HTMLDivElement | null> | undefined,
  active = true,
): number {
  const [bottomOffset, setBottomOffset] = useState(0);

  const measure = useCallback(() => {
    const inputEl = inputAreaRef?.current;
    if (!inputEl) return;
    const rect = inputEl.getBoundingClientRect();
    if (rect.height <= 0) {
      setBottomOffset((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const {height: viewportHeight, top: viewportTop, fixedPosDivisor} = getAppViewport();
    const offset = (viewportHeight - (rect.top - viewportTop) + DOCK_GAP_PX) / fixedPosDivisor;
    setBottomOffset((prev) => (Math.abs(prev - offset) < 1 ? prev : offset));
  }, [inputAreaRef]);

  useEffect(() => {
    if (!active) return;
    measure();
    const inputEl = inputAreaRef?.current;
    const observer = inputEl ? new ResizeObserver(measure) : null;
    if (inputEl && observer) {
      observer.observe(inputEl);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, inputAreaRef, measure]);

  return bottomOffset;
}
