import type { SessionTabData } from '../components/ChatHeader/types';
import type { ClaudeMessage } from '../types';
import type { TabDraft } from './tabDraftStore';

type Updater<T> = T | ((previous: T) => T);

/**
 * Callbacks the view owns. The store calls them; it never implements them.
 *
 * <p>A tab record is view state, but a few consequences of changing it belong
 * to React (mirroring the bound session into `currentSessionId`, closing a tab
 * through the strip, dropping a streaming runtime). Injecting them keeps the
 * store free of hooks without falling back to a window-level object.</p>
 */
export interface TabStoreViewBindings {
  /** Mirror the bound session into the view's `currentSessionId` state. */
  setCurrentSessionId?: (sessionId: string | null) => void;
  /** Mirror an active-tab rename into the view's title state. */
  setCustomSessionTitle?: (title: string | null) => void;
  /** Drop the streaming runtime of a tab that is going away. */
  deleteTabRuntime?: (tabId: string) => void;
  /** Close a tab through the strip (it owns the transition and persistence). */
  closeTab?: (tabId: string) => void;
  /** Drafts are keyed by tab id and owned by the strip. */
  getDrafts?: () => TabDraft[];
  /** Fallback for a tab that never set the auto-open flag. */
  defaultAutoOpenFileEnabled?: boolean;
}

/** Stable, collision-free webview tab id. Never derive it from a timestamp alone. */
export function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tab-${crypto.randomUUID()}`;
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The tab strip of this webview.
 *
 * <p>One webview hosts one chat window, so the strip has the same lifetime as
 * the JS context: a module-level instance, not one per React mount. The
 * message flow reads the active tab's transcript from here, so a conversation
 * exists exactly once in the webview.</p>
 */
let singleton: TabStore | null = null;

export function getTabStore(): TabStore {
  if (singleton === null) {
    singleton = new TabStore([], '');
  }
  return singleton;
}

/**
 * The runtime state of a window that has no tab yet.
 *
 * <p>These fields are part of {@link SessionTabData} because a tab owns its
 * conversation and the turn state that produced it. The view reads them from
 * the active tab; background events write them on the owning tab. There is no
 * window-wide copy that a tab switch would have to move.</p>
 */
const createDetachedTab = (): SessionTabData => ({
  id: '',
  sessionId: null,
  title: '',
  messages: [],
  loading: false,
  streamingActive: false,
  isThinking: false,
  status: undefined,
  turnStartedAt: null,
  isCompacting: false,
  compactingStartTime: null,
  sseTodos: null,
  subagentHistories: {},
});

/** Drop the strip (tests: a fresh window must not inherit the previous tabs). */
export function resetTabStore(): void {
  singleton = new TabStore([], '');
}

/**
 * The webview's authoritative view state: the ordered tabs and the active tab.
 *
 * The host never owns this list; it only receives `tab_activate` notifications.
 * Keeping it in a small external store (instead of the big session hook) makes
 * "what is rendered" independent from streaming/message plumbing and gives the
 * dispatcher one stable place to read tab state from.
 */
export class TabStore {
  private tabs: SessionTabData[];
  private activeTabId: string;
  /**
   * The state of a window that has no tab yet.
   *
   * <p>Before the first tab is created (and in focused tests) the active tab is
   * this object. It owns the same runtime fields as a real tab, so setters keep
   * one code path instead of maintaining a second, window-wide copy.</p>
   */
  private detachedTab: SessionTabData = createDetachedTab();
  private readonly listeners = new Set<() => void>();
  private updatingTabs = false;
  private activeChangedDuringUpdate = false;
  private view: TabStoreViewBindings = {};
  /**
   * Titles that arrived before their session was bound to a tab.
   *
   * <p>The host publishes `tab.title.changed` and `session.bound` as separate
   * events, so a generated title can reach the webview first. Holding it here
   * keeps the title from being dropped without inventing a second copy.</p>
   */
  private readonly pendingTitles = new Map<string, string>();

  constructor(initialTabs: SessionTabData[], activeTabId: string) {
    this.tabs = initialTabs;
    this.activeTabId = activeTabId;
  }

  /**
   * Attach the view callbacks that follow a tab-state change.
   *
   * <p>Called by the tab strip on every render where one of them changes; the
   * store keeps the latest and calls it lazily, so it never captures a stale
   * render closure.</p>
   */
  readonly bindView = (bindings: TabStoreViewBindings): void => {
    this.view = { ...this.view, ...bindings };
  };

  readonly getTabs = (): SessionTabData[] => this.tabs;

  readonly getActiveTabId = (): string => this.activeTabId;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly setTabs = (updater: Updater<SessionTabData[]>): void => {
    this.updatingTabs = true;
    let next: SessionTabData[];
    try {
      next = typeof updater === 'function'
        ? (updater as (previous: SessionTabData[]) => SessionTabData[])(this.tabs)
        : updater;
    } finally {
      this.updatingTabs = false;
    }
    const tabsChanged = next !== this.tabs;
    if (tabsChanged) {
      this.tabs = next;
    }
    if (tabsChanged || this.activeChangedDuringUpdate) {
      this.activeChangedDuringUpdate = false;
      this.emit();
    }
  };

  readonly setActiveTabId = (updater: Updater<string>): void => {
    const next = typeof updater === 'function'
      ? (updater as (previous: string) => string)(this.activeTabId)
      : updater;
    if (next === this.activeTabId) return;
    this.activeTabId = next;
    if (this.updatingTabs) {
      // The tabs updater often switches the active id before returning the new
      // list. Emit once after both snapshots are consistent.
      this.activeChangedDuringUpdate = true;
      return;
    }
    this.emit();
  };

  /** How many tabs the strip holds. */
  size(): number {
    return this.tabs.length;
  }

  findById(tabId: string | null | undefined): SessionTabData | undefined {
    if (!tabId) return undefined;
    return this.tabs.find((tab) => tab.id === tabId);
  }

  /**
   * The tab that is on screen, or the detached state before the first tab.
   *
   * <p>The returned object is the owner of the active transcript and runtime
   * state. Callers must not mutate it; `updateActiveTab` replaces it.</p>
   */
  readonly getActiveTab = (): SessionTabData => (
    this.findById(this.activeTabId) ?? this.detachedTab
  );

  /**
   * Replace the active tab with the result of `updater`.
   *
   * <p>Every runtime setter goes through here, so the active tab remains the
   * only owner of `loading`, `streamingActive`, `isThinking` and the related
   * turn state. A background event writes its own tab through `updateTab`.</p>
   */
  readonly updateActiveTab = (updater: (tab: SessionTabData) => SessionTabData): void => {
    const activeId = this.activeTabId;
    if (!activeId) {
      const next = updater(this.detachedTab);
      if (next === this.detachedTab) return;
      this.detachedTab = next;
      this.emit();
      return;
    }
    this.setTabs((prev) => prev.map((tab) => (
      tab.id === activeId ? updater(tab) : tab
    )));
  };

  /**
   * The transcript of the tab that is on screen.
   *
   * <p>The store owns it: the view reads it from here, so switching tabs
   * never has to copy a transcript into another piece of state.</p>
   */
  getActiveTabMessages(): ClaudeMessage[] {
    return this.getActiveTab().messages ?? [];
  }

  /** The transcript of one tab. */
  getTabMessages(tabId: string | null | undefined): ClaudeMessage[] {
    return this.findById(tabId)?.messages ?? [];
  }

  /**
   * Write the active tab's transcript.
   *
   * <p>The updater receives the tab's current transcript — the owner — and
   * returns the new one.</p>
   */
  updateActiveTabMessages(
    updater: (current: ClaudeMessage[]) => ClaudeMessage[],
  ): void {
    this.updateActiveTab((tab) => ({
      ...tab,
      messages: updater(tab.messages ?? []),
    }));
  }

  findIdBySession(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return this.tabs.find(
      (tab) => tab.sessionId === sessionId || tab.id === sessionId,
    )?.id ?? null;
  }

  findTabBySessionId(sessionId: string | null | undefined): SessionTabData | undefined {
    if (!sessionId) return undefined;
    return this.tabs.find((tab) => tab.sessionId === sessionId || tab.id === sessionId);
  }

  getActiveSessionId(): string | null {
    // Routing reads the tab binding, never a view-level ref: the ref is a
    // projection that lags a commit behind, and using it as "the active
    // session" is what moved one session's events into another tab.
    const active = this.getActiveTab();
    return active.sessionId ?? (active.id || null);
  }

  /**
   * Update one tab.
   *
   * <p>The updater may return the next tab or mutate the copy it receives; both
   * forms are accepted. The store always hands out a copy, so a mutation can
   * never change state without notifying the view.</p>
   */
  updateTab(
    tabId: string | null | undefined,
    updater: (tab: SessionTabData) => SessionTabData | void,
  ): boolean {
    if (!tabId) return false;
    let found = false;
    this.setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) return tab;
        found = true;
        const draft = { ...tab };
        return updater(draft) ?? draft;
      }),
    );
    return found;
  }

  updateBackgroundTab(
    sessionId: string | null | undefined,
    updater: (tab: SessionTabData) => SessionTabData | void,
  ): boolean {
    const tabId = this.findIdBySession(sessionId);
    if (!tabId) return false;
    return this.updateTab(tabId, updater);
  }

  /** Apply one updater to every tab (dialog bookkeeping, bulk cleanup). */
  updateAllTabs(updater: (tab: SessionTabData) => SessionTabData | void): void {
    this.setTabs((prev) => prev.map((tab) => {
      const draft = { ...tab };
      return updater(draft) ?? draft;
    }));
  }

  /** Bind the tab that shows {@code tabId} to a session. */
  updateTabSessionId(tabId: string, sessionId: string): void {
    if (!tabId) return;
    this.setTabs((prev) => prev.map((tab) => (
      tab.id === tabId || tab.sessionId === tabId ? { ...tab, sessionId } : tab
    )));
    if (this.activeTabId === tabId) {
      this.view.setCurrentSessionId?.(sessionId);
    }
    // A title announced before the binding waited here; apply it now.
    const pendingTitle = this.pendingTitles.get(sessionId);
    if (pendingTitle !== undefined) {
      this.pendingTitles.delete(sessionId);
      this.updateTabTitle(sessionId, pendingTitle, tabId);
    }
  }

  /** Rename the tab that owns {@code sessionId} (or the one named by {@code tabId}). */
  updateTabTitle(sessionId: string, newTitle: string, tabId?: string | null): void {
    const trimmed = newTitle?.trim();
    if (!trimmed || !sessionId) return;
    const target = tabId ? this.findById(tabId) : this.findTabBySessionId(sessionId);
    if (!target) {
      // No tab claims this session yet: hold the title for the binding instead
      // of dropping it. A host path that omits tabId is the only way here.
      this.pendingTitles.set(sessionId, trimmed);
      return;
    }
    if (target.isCustomTitle) {
      // A generated title never replaces the name the user gave the tab.
      return;
    }
    this.pendingTitles.delete(sessionId);
    this.updateTab(target.id, (tab) => ({ ...tab, title: trimmed }));
    if (target.id === this.activeTabId) {
      this.view.setCustomSessionTitle?.(trimmed);
    }
  }

  /** Whether the tab on screen opens files touched by the assistant. */
  getActiveTabAutoOpenFileEnabled(): boolean {
    return this.getActiveTab().autoOpenFileEnabled ?? this.view.defaultAutoOpenFileEnabled ?? false;
  }

  /** Drop the streaming runtime of the tab that owns a session. */
  clearStreamingRuntimeFor(sessionId: string | null | undefined): void {
    const owner = this.findIdBySession(sessionId);
    if (owner) this.view.deleteTabRuntime?.(owner);
  }

  /** Close the tab bound to a session (the strip owns what closing means). */
  closeTabBySessionId(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const target = this.tabs.find((tab) => tab.sessionId === sessionId);
    if (target) this.view.closeTab?.(target.id);
  }

  /** The drafts of every tab, for quote-id preservation across a switch. */
  getDrafts(): TabDraft[] {
    return this.view.getDrafts?.() ?? [];
  }

  isActiveTab(tabId: string | null | undefined): boolean {
    if (!tabId) return false;
    return this.activeTabId === tabId;
  }

  isActiveSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    // Store-only: the binding table decides ownership. A view ref must never
    // be able to veto the tab that actually holds this session, or the
    // session's events are treated as background while another session's late
    // events are treated as foreground.
    const active = this.getActiveTab();
    return active.id === sessionId || active.sessionId === sessionId;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
