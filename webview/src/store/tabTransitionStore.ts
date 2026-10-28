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
export interface TabTransitionState {
  /** The session the tab is switching to. */
  targetSessionId: string | null;
  /** Identifies this transition so a stale release cannot cancel a newer one. */
  token: string | null;
  startedAt: number;
}

export class TabTransitionStore {
  private readonly states = new Map<string, TabTransitionState>();

  begin(tabId: string, targetSessionId: string | null, token: string | null): void {
    if (!tabId) return;
    this.states.set(tabId, {
      targetSessionId: targetSessionId ?? null,
      token: token ?? null,
      startedAt: Date.now(),
    });
  }

  /**
   * End the transition of a tab.
   *
   * @param token when given, the transition is only ended if it still carries
   *              that token — a release that arrives late must not cancel the
   *              transition that replaced it
   * @return true when a transition was ended
   */
  end(tabId: string, token?: string | null): boolean {
    if (!tabId) return false;
    const state = this.states.get(tabId);
    if (!state) return false;
    if (token !== undefined && token !== null && state.token !== token) {
      return false;
    }
    this.states.delete(tabId);
    return true;
  }

  isTransitioning(tabId: string | null | undefined): boolean {
    if (!tabId) return false;
    return this.states.has(tabId);
  }

  state(tabId: string | null | undefined): TabTransitionState | undefined {
    if (!tabId) return undefined;
    return this.states.get(tabId);
  }

  /** The session a tab is switching to, or null when it is not transitioning. */
  targetSessionId(tabId: string | null | undefined): string | null {
    return this.state(tabId)?.targetSessionId ?? null;
  }

  token(tabId: string | null | undefined): string | null {
    return this.state(tabId)?.token ?? null;
  }

  startedAt(tabId: string | null | undefined): number {
    return this.state(tabId)?.startedAt ?? 0;
  }

  /** True when any tab is transitioning (window-level diagnostics only). */
  isAnyTransitioning(): boolean {
    return this.states.size > 0;
  }

  delete(tabId: string): void {
    this.states.delete(tabId);
  }

  clear(): void {
    this.states.clear();
  }

  size(): number {
    return this.states.size;
  }
}
