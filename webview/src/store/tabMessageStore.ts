import type { ClaudeMessage } from '../types';
import { getRawUuid } from '../hooks/windowCallbacks/messageSync';

/**
 * Per-tab message store.
 *
 * <p>The transcript is a list, but the identity of a message is not its
 * index: a snapshot that arrives while a delta is in flight shifts every
 * later message by one. Reconciling by id keeps a message's identity (and its
 * streaming state) attached to the message itself, so an update, a removal or
 * a tail replacement never re-targets the wrong row.</p>
 *
 * <p>The store is owned by the tab: the tab object is cloned on every update,
 * but the store instance is shared by reference, so a tab keeps its
 * transcript across those clones.</p>
 */

/** A stable key for a message: its daemon uuid, or a synthesized fallback. */
export function messageKey(message: ClaudeMessage, index: number): string {
  const uuid = getRawUuid(message);
  if (uuid) return `uuid:${uuid}`;
  // Without a uuid the content and the timestamp are the only identity left.
  // The index only breaks ties between otherwise identical messages.
  const content = typeof message.content === 'string' ? message.content : '';
  return `idx:${index}:${message.type}:${content.slice(0, 64)}`;
}

export class TabMessageStore {
  private order: string[] = [];
  private readonly byId = new Map<string, ClaudeMessage>();
  private streamingAssistantId: string | null = null;

  /**
   * Replace the transcript with a snapshot.
   *
   * <p>Messages that are still present keep their identity (and the store's
   * knowledge about the streaming assistant); messages that disappeared are
   * dropped.</p>
   *
   * @returns the reconciled list, in the snapshot's order
   */
  applySnapshot(messages: ClaudeMessage[]): ClaudeMessage[] {
    const nextOrder: string[] = [];
    const nextById = new Map<string, ClaudeMessage>();
    messages.forEach((message, index) => {
      const key = messageKey(message, index);
      nextOrder.push(key);
      nextById.set(key, message);
    });
    this.order = nextOrder;
    this.byId.clear();
    nextById.forEach((message, key) => this.byId.set(key, message));
    if (this.streamingAssistantId && !this.byId.has(this.streamingAssistantId)) {
      // The assistant that was streaming is gone: the turn is over.
      this.streamingAssistantId = null;
    }
    return this.toArray();
  }

  /**
   * Replace the tail of the transcript.
   *
   * <p>The tail carries the messages that changed; everything before it stays
   * as it is.</p>
   */
  applyTail(messages: ClaudeMessage[]): ClaudeMessage[] {
    if (messages.length === 0) return this.toArray();
    const tail = messages.map((message, index) => ({ key: messageKey(message, index), message }));
    const headCount = Math.max(0, this.order.length - tail.length);
    const headKeys = this.order.slice(0, headCount);
    const tailKeys = tail.map((entry) => entry.key);

    this.order = [...headKeys, ...tailKeys];
    for (const entry of tail) {
      this.byId.set(entry.key, entry.message);
    }
    // Prune the entries that are no longer part of the transcript.
    const live = new Set(this.order);
    for (const key of Array.from(this.byId.keys())) {
      if (!live.has(key)) this.byId.delete(key);
    }
    if (this.streamingAssistantId && !this.byId.has(this.streamingAssistantId)) {
      this.streamingAssistantId = null;
    }
    return this.toArray();
  }

  /** Remove messages by id. */
  removeByIds(ids: string[]): ClaudeMessage[] {
    if (ids.length === 0) return this.toArray();
    const removed = new Set(ids);
    this.order = this.order.filter((key) => !removed.has(key));
    ids.forEach((id) => this.byId.delete(id));
    if (this.streamingAssistantId && removed.has(this.streamingAssistantId)) {
      this.streamingAssistantId = null;
    }
    return this.toArray();
  }

  /** Remember which assistant message is currently streaming. */
  markStreamingAssistant(key: string | null): void {
    this.streamingAssistantId = key;
  }

  getStreamingAssistantId(): string | null {
    return this.streamingAssistantId;
  }

  get(key: string): ClaudeMessage | undefined {
    return this.byId.get(key);
  }

  /** The transcript as a plain list, in order. */
  toArray(): ClaudeMessage[] {
    return this.order
      .map((key) => this.byId.get(key))
      .filter((message): message is ClaudeMessage => Boolean(message));
  }

  size(): number {
    return this.order.length;
  }

  clear(): void {
    this.order = [];
    this.byId.clear();
    this.streamingAssistantId = null;
  }
}
