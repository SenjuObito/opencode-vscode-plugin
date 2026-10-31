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
 * Append a text delta to a tab's last assistant message.
 *
 * <p>Ported from idea's `appendDeltaToTab`: the tab record owns the transcript,
 * so a background stream keeps producing visible content without touching the
 * active view. Copy the array before mutating it so React sees a new reference
 * when the tab is selected.</p>
 */
export function appendDeltaToTab(tab: SessionTabData, delta: string): void {
  if (!delta) return;
  (tab as SessionTabData).streamingActive = true;
  (tab as SessionTabData).loading = true;
  const messages = tab.messages ?? [];
  const lastIndex = messages.length - 1;
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
  if (last && last.type === 'assistant') {
    const next = messages.slice();
    const updatedContent = (typeof last.content === 'string' ? last.content : '') + delta;
    let updatedRaw = last.raw;
    if (updatedRaw && typeof updatedRaw === 'object') {
      const rawObj = { ...(updatedRaw as Record<string, unknown>) } as Record<string, any>;
      const msgObj = rawObj.message ? { ...rawObj.message } : { content: [] };
      const contentBlocks = Array.isArray(msgObj.content) ? [...msgObj.content] : [];
      const lastBlockIdx = contentBlocks.length - 1;
      if (lastBlockIdx >= 0 && contentBlocks[lastBlockIdx]?.type === 'text') {
        contentBlocks[lastBlockIdx] = {
          ...contentBlocks[lastBlockIdx],
          text: (contentBlocks[lastBlockIdx].text || '') + delta,
        };
      } else {
        contentBlocks.push({ type: 'text', text: delta });
      }
      msgObj.content = contentBlocks;
      rawObj.message = msgObj;
      updatedRaw = rawObj;
    }
    next[lastIndex] = { ...last, content: updatedContent, raw: updatedRaw };
    tab.messages = next;
    return;
  }
  const initialRaw = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: delta }] },
  };
  const newMessage: ClaudeMessage = {
    type: 'assistant',
    content: delta,
    raw: initialRaw as ClaudeMessage['raw'],
    timestamp: new Date().toISOString(),
  } as ClaudeMessage;
  tab.messages = [...messages, newMessage];
}

/** Replace a tab's transcript with a host snapshot (background tab). */
export function applySnapshotToTab(tab: SessionTabData, messages: ClaudeMessage[]): void {
  if (tab.messageStore) {
    tab.messages = tab.messageStore.applySnapshot(messages);
  } else {
    tab.messages = messages;
  }
}

/** Prepend an older page to a tab's transcript. */
export function applyPrependToTab(tab: SessionTabData, messages: ClaudeMessage[]): void {
  if (messages.length === 0) return;
  if (tab.messageStore) {
    tab.messages = tab.messageStore.applyPrepend(messages);
  } else {
    tab.messages = [...messages, ...(tab.messages ?? [])];
  }
}

/** Apply a tail update to a tab's transcript (background tab). */export function applyTailToTab(tab: SessionTabData, messages: ClaudeMessage[]): void {
  if (tab.messageStore) {
    tab.messages = tab.messageStore.applyTail(messages);
  } else {
    const tail = messages;
    const head = Math.max(0, (tab.messages?.length ?? 0) - tail.length);
    tab.messages = [...(tab.messages ?? []).slice(0, head), ...tail];
  }
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
