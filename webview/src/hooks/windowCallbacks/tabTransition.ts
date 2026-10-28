/**
 * Per-tab session transition state.
 *
 * <p>A transition is the moment a tab starts showing a different session: the
 * outgoing session's late events must not repopulate the new view, and the
 * incoming session's events must not be dropped. Both facts belong to the tab
 * that is switching — not to the window.</p>
 *
 * <p>The previous implementation used one window-wide flag, which meant a
 * background tab's turn was silently dropped whenever *any* tab started a
 * transition. The state is per tab now, and the token keeps a late release
 * from cancelling a transition that has already been replaced by a newer
 * one.</p>
 */
import { TabTransitionStore } from '../../store/tabTransitionStore';
import { getTabStore } from '../../store/tabStore';

export interface TabTransitionState {
  /** The session the tab is switching to. */
  targetSessionId: string | null;
  /** Identifies this transition so a stale release cannot cancel a newer one. */
  token: string | null;
  startedAt: number;
}

/**
 * The one transition store of this webview.
 *
 * <p>A webview hosts one chat window, so a module-level store is the same
 * lifetime as the tab strip — and, unlike a window-global flag, it holds one
 * entry per tab.</p>
 */
const store = new TabTransitionStore();

/** The tab that is on screen. */
export function activeTabId(): string | null {
  return getTabStore().getActiveTabId() || null;
}

/** The tab that owns a session id (null when the session has no tab). */
export function tabIdForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return getTabStore().findIdBySession(sessionId);
}

/**
 * The tab that owns a session, counting a tab that is switching to it.
 *
 * <p>Rebinding lands a moment after a switch starts: events for the incoming
 * session arrive in that window and must still find their tab. The transition
 * target is per tab, so this stays a statement about the binding rather than a
 * window-level guess.</p>
 */
export function owningTabIdForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const store = getTabStore();
  const owner = store.findIdBySession(sessionId);
  if (owner) return owner;
  const switching = store.getTabs().find((tab) => transitionTargetFor(tab.id) === sessionId);
  return switching?.id ?? null;
}

/** Start a transition for a tab. */
export function beginTransition(
  tabId: string | null | undefined,
  targetSessionId: string | null,
  token: string | null,
): void {
  if (!tabId) return;
  store.begin(tabId, targetSessionId, token);
}

/**
 * End a tab's transition.
 *
 * @param token when given, only a transition with that token is ended — a
 *              release that arrives late must not cancel the transition that
 *              replaced it
 */
export function endTransition(tabId: string | null | undefined, token?: string | null): boolean {
  if (!tabId) return false;
  return store.end(tabId, token);
}

/** Is this tab switching sessions right now? */
export function isTabTransitioning(tabId: string | null | undefined): boolean {
  return store.isTransitioning(tabId);
}

/** The session the tab is switching to, or null. */
export function transitionTargetFor(tabId: string | null | undefined): string | null {
  return store.targetSessionId(tabId);
}

/** The token of the tab's current transition, or null. */
export function transitionTokenFor(tabId: string | null | undefined): string | null {
  return store.token(tabId);
}

/** Drop a tab's transition (the tab was closed). */
export function clearTransition(tabId: string | null | undefined): void {
  if (!tabId) return;
  store.delete(tabId);
}

/**
 * Is the tab that owns this session switching right now?
 *
 * <p>When the session has no tab, the active tab is asked instead: an event
 * that arrives without an owner still has to be judged by the view that would
 * display it.</p>
 */
export function isSessionTransitioning(sessionId: string | null | undefined): boolean {
  const tabId = tabIdForSession(sessionId) ?? activeTabId();
  return store.isTransitioning(tabId);
}

/**
 * The session the owning tab is switching to, or null.
 *
 * @param sessionId the session the caller asks about; the owning tab decides
 */
export function transitionTargetOfSession(sessionId: string | null | undefined): string | null {
  const tabId = tabIdForSession(sessionId) ?? activeTabId();
  return store.targetSessionId(tabId);
}
