import type { SessionTabData } from '../components/ChatHeader/types';

/**
 * Whether a tab has a turn that is still running.
 *
 * <p>`loading` covers the window between a request and the first stream event;
 * `streamingActive` covers the stream itself. They are two phases of one turn,
 * so every busy indicator (composer stop button, tab title, notice bar) must
 * use this derivation instead of picking one phase and guessing.</p>
 */
export function isTabTurnActive(
  tab: Pick<SessionTabData, 'loading' | 'streamingActive'> | null | undefined,
): boolean {
  return Boolean(tab?.loading || tab?.streamingActive);
}
