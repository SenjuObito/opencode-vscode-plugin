/**
 * The webview half of the host-owned message queue.
 *
 * <p>The host owns the queue; this module only defines the projection shape and
 * the reducer that applies `tab.queue.changed`. Keeping both here means the UI,
 * the event callback and the tests agree on one representation.</p>
 */
import type { HostEventPayload } from '../utils/hostEventTypes';

export interface QueuedAttachmentView {
  attachmentId: string;
  fileName?: string;
  mediaType?: string;
}

export interface QueuedMessage {
  id: string;
  content: string;
  /** Set when the waiting item is a session command (`/compact`, `/undo`, ...). */
  command?: string | null;
  attachments?: QueuedAttachmentView[];
  model?: string | null;
  permissionMode?: string | null;
  reasoningEffort?: string | null;
  createdAt: number;
}

export interface TabQueueErrorView {
  itemId: string;
  message: string;
}

export interface TabQueueSnapshot {
  /** Items waiting for their turn. The one being sent is not queued any more. */
  items: QueuedMessage[];
  /** True after the user stopped a turn: the queue waits for a resume. */
  paused: boolean;
  lastError: TabQueueErrorView | null;
}

/** Shared empty snapshot: a stable reference keeps `useSyncExternalStore` quiet. */
export const EMPTY_TAB_QUEUE: TabQueueSnapshot = {
  items: [],
  paused: false,
  lastError: null,
};

function parseAttachment(raw: unknown): QueuedAttachmentView | null {
  if (!raw || typeof raw !== 'object') return null;
  const attachment = raw as Record<string, unknown>;
  const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
  if (!attachmentId) return null;
  return {
    attachmentId,
    fileName: typeof attachment.fileName === 'string' ? attachment.fileName : undefined,
    mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined,
  };
}

function parseItem(raw: unknown): QueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  if (!id) return null;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map(parseAttachment).filter((entry): entry is QueuedAttachmentView => !!entry)
    : [];
  return {
    id,
    content: typeof item.text === 'string' ? item.text : '',
    command: typeof item.command === 'string' ? item.command : null,
    attachments,
    model: typeof item.model === 'string' ? item.model : null,
    permissionMode: typeof item.permissionMode === 'string' ? item.permissionMode : null,
    reasoningEffort: typeof item.reasoningEffort === 'string' ? item.reasoningEffort : null,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
  };
}

/** Normalize a `tab.queue.changed` payload, or null when it is malformed. */
export function parseTabQueuePayload(payload: unknown): TabQueueSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as HostEventPayload;
  const items = Array.isArray(data.items)
    ? data.items.map(parseItem).filter((entry): entry is QueuedMessage => !!entry)
    : [];
  const error = data.lastError && typeof data.lastError === 'object'
    ? data.lastError as Record<string, unknown>
    : null;
  return {
    items,
    paused: data.paused === true,
    lastError: error && typeof error.message === 'string'
      ? {
        itemId: typeof error.itemId === 'string' ? error.itemId : '',
        message: error.message,
      }
      : null,
  };
}
