/**
 * Routing helpers for named host events.
 *
 * <p>The host names the tab that owns every data event. A background tab must
 * absorb the event into its own record/store; only the active tab may touch the
 * view's React state. This module is the single place that decides which one
 * happens.</p>
 */
import type { SessionTabData } from '../components/ChatHeader/types';
import type { ClaudeMessage } from '../types';
import { getTabStore } from '../store/tabStore';
import type { HostEventEnvelope } from './hostEventTypes';

/** The tab named by the envelope, or null for a window-level event. */
export function eventTabId(envelope?: HostEventEnvelope | null): string | null {
  const tabId = envelope?.tabId;
  return typeof tabId === 'string' && tabId.length > 0 ? tabId : null;
}

/** Whether the named event belongs to the tab currently on screen. */
export function isActiveTabEvent(envelope?: HostEventEnvelope | null): boolean {
  const tabId = eventTabId(envelope);
  if (!tabId) return true;
  return getTabStore().isActiveTab(tabId);
}

/**
 * Apply an event to a background tab.
 *
 * @returns true when the event was handled as a background event; false when
 * the caller should run its active-tab path.
 */
export function updateBackgroundTab(
  envelope: HostEventEnvelope | null | undefined,
  updater: (tab: SessionTabData) => void,
): boolean {
  const tabId = eventTabId(envelope);
  if (!tabId) {
    return false;
  }
  const store = getTabStore();
  if (store.isActiveTab(tabId)) {
    return false;
  }
  // A named tab that this view has not learned yet must not fall through to
  // the active view: that is exactly the cross-tab corruption this layer
  // exists to prevent. Drop it; the host replays the tab on resync/create.
  if (!store.findById(tabId)) {
    return true;
  }
  return store.updateTab(tabId, (tab) => {
    updater(tab);
  });
}

/**
 * Append one content delta to a tab's streaming assistant bubble.
 *
 * <p>The transcript owns the merge (text and matching raw blocks), so this only
 * states the fact: a delta arrived for this tab's open turn.</p>
 */
export function appendDeltaToTab(tab: SessionTabData, delta: string): void {
  if (!delta) return;
  tab.streamingActive = true;
  tab.loading = true;
  tab.transcript.appendDelta(delta, tab.transcript.streamingAssistantTurn());
}

/** Replace a tab's transcript with a host snapshot (background tab). */
export function applySnapshotToTab(tab: SessionTabData, messages: ClaudeMessage[]): void {
  tab.transcript.applySnapshot(messages);
  // Background tabs keep no delta buffers; discard the boundary flag so a later
  // foreground read cannot reset the active tab's buffers with it.
  tab.transcript.consumeCompactionBoundary();
}

/** Prepend an older page to a tab's transcript. */
export function applyPrependToTab(tab: SessionTabData, messages: ClaudeMessage[]): void {
  if (messages.length === 0) return;
  tab.transcript.prependPage(messages);
}

/** Apply a tail update to a tab's transcript (background tab). */
export function applyTailToTab(tab: SessionTabData, messages: ClaudeMessage[], baseIndex = 0): void {
  if (messages.length === 0) return;
  tab.transcript.applyTail(messages, baseIndex);
}

/** Parse a JSON payload that may arrive as a string or an object. */
export function parseEventJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}
