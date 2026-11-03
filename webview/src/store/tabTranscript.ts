import type { ClaudeMessage } from '../types';
import { getRawUuid, mergeRawBlocksDuringStreaming } from '../hooks/windowCallbacks/messageSync';
import { collectToolResultIds, getRawContentBlocks, getTextLenFromRaw, rawHasContent, toolResultIdsOf } from '../utils/messageRaw';

/**
 * One tab's transcript.
 *
 * <p>The transcript is owned here and nowhere else. The view reads
 * {@link getSnapshot}; the event layer translates host facts into one of the
 * named operations below. There is no second array to keep in sync, and no
 * "foreground vs background" variant of any operation: the only difference
 * between the two is which tab receives it.</p>
 *
 * <p>Two segments make up the list, in this order:</p>
 * <ul>
 *   <li><b>remote</b> — what the host has confirmed. Snapshots, tails, older
 *       pages and removals all apply here.</li>
 *   <li><b>local</b> — optimistic bubbles the user sent but the host has not
 *       echoed yet. A snapshot never erases them; confirmation converts one
 *       into its remote identity.</li>
 * </ul>
 */

/** A stable identity for a message: provider id, then content fingerprint. */
export function messageKey(message: ClaudeMessage, index: number): string {
  const uuid = getRawUuid(message);
  if (uuid) return `uuid:${uuid}`;
  return `fp:${fingerprint(message)}:${index}`;
}

/**
 * Identity used for cross-page de-duplication.
 *
 * <p>Index is deliberately NOT part of this: it differs between the page and
 * the transcript, so including it would make the same record look like two.
 * A provider id is exact; without one, the semantic fields are.</p>
 */
function fingerprint(message: ClaudeMessage): string {
  const uuid = getRawUuid(message);
  if (uuid) return `uuid:${uuid}`;
  const content = typeof message.content === 'string' ? message.content : '';
  // Structural content (tool_result blocks etc.) is what distinguishes messages
  // that share a type, a timestamp and an empty text body — three parallel tool
  // results are exactly that shape.
  return `${message.type}|${message.timestamp ?? ''}|${content.slice(0, 120)}|${rawDigest(message.raw)}`;
}

/** A cheap, stable digest of a message's content blocks. */
function rawDigest(raw: unknown): string {
  const blocks = getRawContentBlocks(raw);
  const text = blocks.length > 0
    ? JSON.stringify(blocks)
    : (typeof raw === 'string' ? raw : '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export interface TranscriptSnapshot {
  messages: ClaudeMessage[];
  pagedCount: number;
  baseIndex: number;
  windowStart: number;
}

interface LocalEntry {
  clientId: string;
  message: ClaudeMessage;
  /** Provider id once the host has echoed this bubble. */
  providerId?: string;
}

export class TabTranscript {
  private order: string[] = [];
  private readonly byId = new Map<string, ClaudeMessage>();
  private local: LocalEntry[] = [];
  /**
   * The assistant bubble of the turn currently streaming.
   *
   * <p>It is not part of `remote` yet: a host snapshot that was generated
   * before the last delta must not erase text the user is already reading.
   * It joins `remote` when the turn settles.</p>
   */
  private pendingAssistant: ClaudeMessage | null = null;
  private snapshot: ClaudeMessage[] | null = null;
  private streamingTurnId: number | null = null;
  /**
   * Set when a snapshot/tail crossed a compaction boundary.
   *
   * <p>The view keeps its own delta buffers for the open turn. Once the
   * pre-compaction bubble is sealed, those buffers still hold the old segment's
   * text; the view must drop them before the first post-compaction snapshot
   * merges, or the new bubble inherits the old text.</p>
   */
  private compactionBoundaryCrossed = false;

  /** How many leading remote messages came from older disk pages. */
  private paged = 0;
  /** Global index the host's current window starts at. */
  private base = 0;
  /** Global index the local list starts at (paging moved it backwards). */
  private start = 0;

  // ── reads ────────────────────────────────────────────────────────────────

  /** The merged list the view renders. Stable by reference until a change. */
  getSnapshot(): ClaudeMessage[] {
    if (this.snapshot === null) {
      this.snapshot = [
        ...this.remoteArray(),
        ...this.local.map((entry) => entry.message),
        ...(this.pendingAssistant ? [this.pendingAssistant] : []),
      ];
    }
    return this.snapshot;
  }

  size(): number {
    return this.order.length + this.local.length + (this.pendingAssistant ? 1 : 0);
  }

  pagedCount(): number {
    return this.paged;
  }

  baseIndex(): number {
    return this.base;
  }

  windowStart(): number {
    return this.start;
  }

  streamingAssistantTurn(): number | null {
    return this.streamingTurnId;
  }

  /** True once after a snapshot settled a bubble at a compaction boundary. */
  consumeCompactionBoundary(): boolean {
    if (!this.compactionBoundaryCrossed) return false;
    this.compactionBoundaryCrossed = false;
    return true;
  }

  get(key: string): ClaudeMessage | undefined {
    return this.byId.get(key);
  }

  // ── remote facts ─────────────────────────────────────────────────────────

  /**
   * Replace the host window.
   *
   * <p>An older page already read into this tab is older than any window the
   * host can send afterwards, so it is kept in front of the new snapshot. The
   * two are de-duplicated by identity because the window and the page overlap
   * at the boundary.</p>
   */
  applySnapshot(messages: ClaudeMessage[], baseIndex = 0): void {
    const newBase = Number.isSafeInteger(baseIndex) && baseIndex >= 0 ? baseIndex : 0;
    let windowMessages = messages;

    // The host's copy of the assistant that is still streaming is a progress
    // report, not a confirmed message: `pendingAssistant` owns that bubble. Its
    // structural blocks (tool_use, tool_result) come from the host, its
    // text/thinking keeps whichever side is further ahead.
    //
    // A compaction record is the segment boundary. A pending bubble that sits
    // before the newest boundary belongs to the pre-compaction segment and must
    // land there, not below the card; one that sits after it is the open
    // segment and keeps the normal merge.
    const pending = this.pendingAssistant;
    const compactionIndex = lastCompactionIndex(messages);
    if (pending) {
      const streamingIndex = lastStreamingCopyIndex(messages, pending);
      if (streamingIndex >= 0) {
        const incoming = messages[streamingIndex];
        windowMessages = messages.filter((_, index) => index !== streamingIndex);
        const incomingContent = incoming.content ?? '';
        const pendingContent = pending.content ?? '';
        this.pendingAssistant = {
          ...pending,
          content: incomingContent.length > pendingContent.length ? incomingContent : pendingContent,
          raw: mergeRawBlocksDuringStreaming(pending.raw, incoming.raw) as ClaudeMessage['raw'],
        };
      } else if (compactionIndex >= 0) {
        windowMessages = [...messages];
        const preIndex = lastAssistantIndexBefore(windowMessages, compactionIndex);
        if (preIndex >= 0) {
          windowMessages[preIndex] = mergePendingIntoHost(windowMessages[preIndex], pending);
        } else {
          windowMessages.splice(compactionIndex, 0, pending);
        }
        // The next delta belongs to the post-compaction segment and opens a new
        // bubble; it must never be appended to the sealed one.
        this.pendingAssistant = null;
        this.compactionBoundaryCrossed = true;
      }
    }

    // Everything that came before the new window stays in front of it: the
    // pages already read on top, plus the head of the old window that slid
    // out of the host's newest snapshot. That keeps the list globally
    // continuous instead of leaving a gap where the window moved.
    const slidOut = Math.max(0, newBase - this.base);
    const headCount = Math.min(this.order.length, this.paged + slidOut);
    const headMessages = this.order
      .slice(0, headCount)
      .map((key) => this.byId.get(key))
      .filter((message): message is ClaudeMessage => Boolean(message));

    const known = new Set(headMessages.map(fingerprint));
    const next: ClaudeMessage[] = [...headMessages];
    for (const message of windowMessages) {
      const fp = fingerprint(message);
      if (known.has(fp)) continue;
      known.add(fp);
      next.push(message);
    }

    // A snapshot generated before the host echoed an optimistic prompt cannot
    // erase it: the user is looking at it. It is re-added once the echo
    // arrives (matched by content), exactly like a local bubble. Placement
    // matters too — it belongs directly above its own turn's answer, not at
    // the bottom of the list.
    const previous = this.remoteArray();
    for (const message of previous) {
      if (!message.isOptimistic) continue;
      if (next.some((candidate) => contentKey(candidate) === contentKey(message))) continue;

      let anchor = -1;
      const optimisticIndex = previous.indexOf(message);
      for (let i = optimisticIndex + 1; i < previous.length; i += 1) {
        const follower = previous[i];
        if (follower?.type === 'assistant' && typeof follower.__turnId === 'number' && follower.__turnId > 0) {
          anchor = next.findIndex((candidate) => (
            candidate.type === 'assistant' && candidate.__turnId === follower.__turnId
          ));
          break;
        }
      }
      if (anchor < 0) {
        const last = next[next.length - 1];
        if (last?.type === 'assistant' && last.isStreaming) anchor = next.length - 1;
      }
      if (anchor < 0) {
        next.push(message);
      } else {
        next.splice(anchor, 0, message);
      }
    }

    this.base = newBase;
    this.replaceRemote(next);
    // Every kept message lies before the new window.
    this.paged = Math.min(headCount, next.length);
  }

  /**
   * Replace the tail of the host window.
   *
   * <p>`baseIndex` is the window-relative start of the tail. When it lies
   * inside the current window the prefix is kept; when the window slid past
   * it, only the older pages survive in front of the tail.</p>
   */
  applyTail(messages: ClaudeMessage[], baseIndex: number): void {
    if (messages.length === 0) return;
    const windowCount = Math.max(0, this.order.length - this.paged);
    const tailStart = Number.isSafeInteger(baseIndex) && baseIndex >= 0 ? baseIndex : this.base;
    // The prefix is complete only while this tab holds the window from global
    // index 0: then the tail starts inside it and everything before the tail
    // stays. Otherwise the tail is a new window and only older pages survive.
    const hasFullPrefix = this.base === 0 && tailStart <= windowCount;
    const headCount = hasFullPrefix ? this.paged + tailStart : this.paged;
    const headMessages = this.order
      .slice(0, headCount)
      .map((key) => this.byId.get(key))
      .filter((message): message is ClaudeMessage => Boolean(message));

    // A tail can carry a compaction record too (long conversations). Apply the
    // same boundary rule as `applySnapshot`: settle the pre-compaction pending
    // into the assistant before the card, or merge a post-compaction streaming
    // copy into the open bubble instead of duplicating it.
    const pending = this.pendingAssistant;
    const compactionIndex = lastCompactionIndex(messages);
    if (pending && compactionIndex >= 0) {
      const postIndex = lastAssistantIndexAfter(messages, compactionIndex);
      if (postIndex >= 0) {
        const incoming = messages[postIndex];
        messages = messages.filter((_, index) => index !== postIndex);
        const incomingContent = incoming.content ?? '';
        const pendingContent = pending.content ?? '';
        this.pendingAssistant = {
          ...pending,
          content: incomingContent.length > pendingContent.length ? incomingContent : pendingContent,
          raw: mergeRawBlocksDuringStreaming(pending.raw, incoming.raw) as ClaudeMessage['raw'],
        };
      } else {
        const tail = [...messages];
        const preIndex = lastAssistantIndexBefore(tail, compactionIndex);
        if (preIndex >= 0) {
          tail[preIndex] = mergePendingIntoHost(tail[preIndex], pending);
        } else {
          const headIndex = lastAssistantIndexIn(headMessages);
          if (headIndex >= 0) {
            headMessages[headIndex] = mergePendingIntoHost(headMessages[headIndex], pending);
          }
        }
        messages = tail;
        this.pendingAssistant = null;
        this.compactionBoundaryCrossed = true;
      }
    }

    this.base = hasFullPrefix ? 0 : tailStart;
    this.replaceRemote([...headMessages, ...messages]);
    this.paged = Math.min(this.paged, headMessages.length);
  }

  /**
   * Prepend one older page.
   *
   * <p>A page and the transcript overlap at the boundary (the server pages by
   * record, not by turn), so a record that is already present is skipped
   * instead of rendered twice.</p>
   */
  prependPage(messages: ClaudeMessage[], pageStart?: number): number {
    if (messages.length === 0) return 0;
    const known = new Set(this.remoteArray().map(fingerprint));
    const fresh: ClaudeMessage[] = [];
    for (const message of messages) {
      const fp = fingerprint(message);
      if (known.has(fp)) continue;
      known.add(fp);
      fresh.push(message);
    }
    if (fresh.length === 0) return 0;
    const previous = this.remoteArray();
    this.replaceRemote([...fresh, ...previous]);
    this.paged = Math.min(this.order.length, this.paged + fresh.length);
    if (pageStart != null && Number.isSafeInteger(pageStart) && pageStart >= 0) {
      this.start = pageStart;
    }
    return fresh.length;
  }

  /** Append a host-confirmed message (a user message the host acknowledged). */
  appendRemote(message: ClaudeMessage): void {
    const list = this.remoteArray();
    const existing = new Set(list.map(fingerprint));
    if (existing.has(fingerprint(message))) return;
    this.replaceRemote([...list, message]);
  }

  removeByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const removed = new Set(ids);
    const next = this.remoteArray().filter((message) => {
      const providerId = providerIdOf(message);
      return !(providerId != null && removed.has(providerId));
    });
    // Local bubbles the host removed are gone too: the send failed.
    this.local = this.local.filter((entry) => {
      if (entry.providerId && removed.has(entry.providerId)) return false;
      return !removed.has(entry.clientId);
    });
    if (this.pendingAssistant) {
      const providerId = providerIdOf(this.pendingAssistant);
      if (providerId && removed.has(providerId)) this.pendingAssistant = null;
    }
    this.replaceRemote(next);
  }

  clear(): void {
    this.local = [];
    this.pendingAssistant = null;
    this.streamingTurnId = null;
    this.compactionBoundaryCrossed = false;
    this.paged = 0;
    this.base = 0;
    this.start = 0;
    this.replaceRemote([]);
  }

  /** Drop everything from `index` on (revert). */
  truncateAt(index: number): void {
    const safe = Math.max(0, Math.min(index, this.order.length));
    this.replaceRemote(this.remoteArray().slice(0, safe));
    this.paged = Math.min(this.paged, safe);
  }

  /**
   * Stamp a provider id onto the user message the host just acknowledged.
   *
   * <p>The ack can arrive while the bubble is still optimistic (local), so the
   * local segment is searched first. Matching falls back to the raw text blocks
   * because the host echoes the rendered prompt, which can differ from the
   * plain `content` field once attachments are expanded.</p>
   */
  assignProviderId(content: string, uuid: string): void {
    const matches = (message: ClaudeMessage): boolean => {
      if (message.type !== 'user' || getRawUuid(message)) return false;
      if ((message.content ?? '') === content) return true;
      const rawText = getRawContentBlocks(message.raw)
        .filter((block) => (block as { type?: string; text?: string })?.type === 'text')
        .map((block) => String((block as { text?: string }).text ?? ''))
        .join('\n');
      return rawText === content;
    };

    const stamp = (message: ClaudeMessage): ClaudeMessage => {
      const raw: ClaudeMessage['raw'] =
        typeof message.raw === 'object' && message.raw
          ? { ...message.raw, uuid }
          : {
              uuid,
              message: {
                content: [{ type: 'text' as const, text: message.content || content }],
              },
            };
      return { ...message, raw };
    };

    const localIndex = this.local.findIndex((entry) => matches(entry.message));
    if (localIndex >= 0) {
      this.local = this.local.map((entry, index) => (
        index === localIndex ? { ...entry, providerId: uuid, message: stamp(entry.message) } : entry
      ));
      this.snapshot = null;
      return;
    }

    for (let i = this.order.length - 1; i >= 0; i--) {
      const message = this.byId.get(this.order[i]);
      if (!message || !matches(message)) continue;
      this.replaceMessageAt(i, stamp(message));
      return;
    }
  }

  /** Stamp a duration on the newest assistant message (turn footer). */
  patchLastAssistant(updater: (message: ClaudeMessage) => ClaudeMessage): void {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const message = this.byId.get(this.order[i]);
      if (!message || message.type !== 'assistant') continue;
      this.replaceMessageAt(i, updater(message));
      return;
    }
  }

  // ── streaming ────────────────────────────────────────────────────────────

  /**
   * Open (or reopen) the assistant bubble of a turn.
   *
   * <p>Three cases, all driven by identity instead of an index:</p>
   * <ul>
   *   <li>a replay must reuse the last assistant bubble;</li>
   *   <li>an empty streaming bubble of an older turn is reclaimed;</li>
   *   <li>a non-empty older streaming bubble is finalised and a new one opens.</li>
   * </ul>
   */
  beginAssistant(turnId: number, replay: boolean): number {
    this.streamingTurnId = turnId;
    this.snapshot = null;
    const pending = this.pendingAssistant;

    if (replay) {
      if (pending) {
        this.pendingAssistant = { ...pending, isStreaming: true, __turnId: turnId };
        return this.indexOfPending();
      }
      const lastIndex = this.lastRemoteAssistantIndex();
      if (lastIndex >= 0) {
        // A replay reuses the last assistant bubble: moving it to `pending`
        // keeps it out of the next host snapshot until the turn settles.
        const last = this.byId.get(this.order[lastIndex])!;
        this.removeRemoteAt(lastIndex);
        this.pendingAssistant = { ...last, isStreaming: true, __turnId: turnId };
        return this.indexOfPending();
      }
    }

    if (pending) {
      if (pending.__turnId === turnId) {
        this.pendingAssistant = { ...pending, isStreaming: true };
        return this.indexOfPending();
      }
      if (!hasContent(pending)) {
        // An empty placeholder from an older turn is reclaimed, not finalised:
        // finalising it would leave a blank ghost bubble behind.
        this.pendingAssistant = {
          ...pending,
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString(),
          __turnId: turnId,
        };
        return this.indexOfPending();
      }
      this.settleAssistant(pending.__turnId ?? null);
    }

    const lastIndex = this.lastRemoteAssistantIndex();
    if (lastIndex >= 0) {
      const last = this.byId.get(this.order[lastIndex])!;
      const lastTurnId = last.__turnId;
      // Only a bubble this webview opened for an earlier turn is a leftover.
      // History rows can carry `isStreaming: true` with no turn id; they are
      // not this session's turn and must be left exactly as loaded.
      const isOlderStreamingTurn = last.isStreaming
        && typeof lastTurnId === 'number'
        && lastTurnId > 0
        && lastTurnId < turnId;
      if (isOlderStreamingTurn) {
        if (!hasContent(last)) {
          // An empty placeholder from an older turn is reclaimed, not finalised:
          // finalising it would leave a blank ghost bubble behind.
          this.removeRemoteAt(lastIndex);
          this.pendingAssistant = {
            ...last,
            content: '',
            isStreaming: true,
            timestamp: new Date().toISOString(),
            __turnId: turnId,
          };
          return this.indexOfPending();
        }
        // Close it in place: pushing it to the end would move the bubble below
        // the tool results that belong to this turn.
        this.replaceMessageAt(lastIndex, { ...last, isStreaming: false });
      }
    }

    this.pendingAssistant = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: new Date().toISOString(),
      __turnId: turnId,
    };
    return this.indexOfPending();
  }

  /** Patch the assistant bubble of `turnId` (or the newest assistant). */
  patchAssistant(
    turnId: number | null,
    updater: (message: ClaudeMessage) => ClaudeMessage,
  ): number {
    const pending = this.pendingAssistant;
    if (pending && (turnId == null || pending.__turnId === turnId)) {
      this.pendingAssistant = updater(pending);
      return this.indexOfPending();
    }
    const list = this.remoteArray();
    const segmentStart = this.segmentStartIndex();
    let index = -1;
    if (turnId != null) {
      for (let i = list.length - 1; i >= segmentStart; i--) {
        if (list[i]?.type === 'assistant' && list[i].__turnId === turnId) {
          index = i;
          break;
        }
      }
    }
    if (index < 0) index = this.lastRemoteAssistantIndex();
    if (index < 0) return -1;
    list[index] = updater(list[index]);
    this.replaceRemote(list);
    return index;
  }

  /** Close the streaming bubble of a turn and stamp its duration. */
  settleAssistant(turnId: number | null, durationMs?: number): void {
    this.streamingTurnId = null;
    const pending = this.pendingAssistant;
    if (pending) {
      this.pendingAssistant = null;
      this.pushRemote({
        ...pending,
        isStreaming: false,
        durationMs: durationMs != null && pending.durationMs == null ? durationMs : pending.durationMs,
      });
      return;
    }
    this.patchAssistant(turnId, (message) => ({
      ...message,
      isStreaming: false,
      durationMs: durationMs != null && message.durationMs == null ? durationMs : message.durationMs,
    }));
  }

  /**
   * Rebuild per-turn metadata over the whole transcript.
   *
   * <p>Lives here because it is a change to the transcript, not a rendering
   * concern; the transformation itself stays a pure function.</p>
   */
  rebuildMetadata(transform: (messages: ClaudeMessage[]) => ClaudeMessage[]): void {
    const next = transform(this.remoteArray());
    this.replaceRemote(next);
  }

  /** Force a re-render without changing content (denied tool ids, etc.). */
  touch(): void {
    this.snapshot = null;
  }

  /**
   * Hand every message a fresh object identity.
   *
   * <p>A history reload re-delivers records the tab may already hold; message
   * components memoise on the message object, so reusing the old objects would
   * leave rendered Markdown (and resolved tool cards) stale on screen. This is
   * the transcript's repaint, not a content change: order and values stay.</p>
   */
  rehydrate(): void {
    if (this.size() === 0) return;
    for (const key of this.order) {
      const message = this.byId.get(key);
      if (message) this.byId.set(key, { ...message });
    }
    this.local = this.local.map((entry) => ({ ...entry, message: { ...entry.message } }));
    if (this.pendingAssistant) this.pendingAssistant = { ...this.pendingAssistant };
    this.snapshot = null;
  }

  /**
   * Append one content delta to the assistant bubble of `turnId`.
   *
   * <p>The text block inside `raw` grows with the top-level content: tool cards
   * and thinking blocks read the raw form, so updating only `content` would
   * leave them stale.</p>
   */
  appendDelta(delta: string, turnId: number | null): void {
    const apply = (message: ClaudeMessage): ClaudeMessage => {
      const nextContent = (message.content ?? '') + delta;
      const raw = message.raw;
      if (!raw || typeof raw !== 'object') {
        // A bubble that never carried raw still needs one: the renderer reads
        // text blocks from raw, and the ending snapshot is merged into it.
        return {
          ...message,
          content: nextContent,
          raw: {
            type: 'assistant',
            message: { content: [{ type: 'text', text: nextContent }] },
          } as ClaudeMessage['raw'],
        };
      }
      const rawObj = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
      const messageObj: Record<string, unknown> = rawObj.message
        ? { ...(rawObj.message as Record<string, unknown>) }
        : { content: [] as unknown[] };
      const blocks: unknown[] = Array.isArray(messageObj.content) ? [...(messageObj.content as unknown[])] : [];
      const lastIndex = blocks.length - 1;
      const last = blocks[lastIndex] as { type?: string; text?: string } | undefined;
      if (lastIndex >= 0 && last?.type === 'text') {
        blocks[lastIndex] = { ...last, text: (last.text ?? '') + delta };
      } else {
        blocks.push({ type: 'text', text: delta });
      }
      messageObj.content = blocks;
      rawObj.message = messageObj;
      return { ...message, content: nextContent, raw: rawObj as ClaudeMessage['raw'] };
    };

    const pending = this.pendingAssistant;
    if (pending && (turnId == null || pending.__turnId === turnId)) {
      this.pendingAssistant = apply(pending);
      this.snapshot = null;
      return;
    }
    // A delta never rewrites a sealed assistant. When the current segment has
    // no assistant yet (the first delta after a compaction), open a new bubble;
    // otherwise patch the segment's assistant (background tabs, replays).
    if (this.lastRemoteAssistantIndex() >= 0) {
      this.patchAssistant(turnId, apply);
      return;
    }
    this.openStreamingBubble(turnId ?? this.streamingTurnId ?? -1);
    this.pendingAssistant = apply(this.pendingAssistant as ClaudeMessage);
    this.snapshot = null;
  }

  /** Open an empty streaming bubble for the current segment. */
  private openStreamingBubble(turnId: number): void {
    this.streamingTurnId = turnId;
    this.pendingAssistant = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: new Date().toISOString(),
      __turnId: turnId,
    };
  }

  /**
   * Settle the streaming turn.
   *
   * <p>Merges the final text/raw, drops an empty bubble, recovers tool results
   * that arrived while the UI was between frames, and rebuilds the per-turn
   * footer metadata. Everything happens in one write so no observer can see a
   * half-settled transcript.</p>
   *
   */
  finalizeStreamingTurn(
    params: {
      turnId: number;
      content: string;
      backendRaw: unknown;
      durationMs?: number;
      pendingToolResults: Array<{ content: string; raw: unknown }>;
      toolResultTimestamp: string;
    },
    rebuild: (messages: ClaudeMessage[]) => ClaudeMessage[],
  ): void {
    const pending = this.pendingAssistant;
    const list = this.remoteArray();
    let index = -1;
    let current: ClaudeMessage | undefined;

    if (pending && (params.turnId <= 0 || pending.__turnId === params.turnId)) {
      current = pending;
      this.pendingAssistant = null;
    } else if (pending) {
      // A pending bubble of another turn has to land before this one settles.
      list.push(pending);
      this.pendingAssistant = null;
      index = list.length - 1;
      current = pending;
    }
    const segmentStart = lastCompactionIndex(list) + 1;
    if (!current) {
      for (let i = list.length - 1; i >= segmentStart; i--) {
        if (list[i]?.type === 'assistant' && list[i].__turnId === params.turnId) {
          index = i;
          current = list[i];
          break;
        }
      }
    }
    if (!current) {
      // A bubble that lost its `__turnId` (or never carried one) is still the
      // open turn: an open turn cannot have a settled last assistant.
      for (let i = list.length - 1; i >= segmentStart; i--) {
        if (list[i]?.type === 'assistant' && list[i].isStreaming) {
          index = i;
          current = list[i];
          break;
        }
      }
    }
    if (current && index < 0) {
      index = list.length;
      list.push(current);
    }

    if (current && index >= 0) {
      const finalContent = params.content || current.content || '';
      let finalRaw = current.raw;
      if (params.backendRaw != null) {
        const backendTextLen = getTextLenFromRaw(params.backendRaw);
        const existingTextLen = getTextLenFromRaw(finalRaw);
        const backendBlocks = getRawContentBlocks(params.backendRaw);
        const existingBlocks = getRawContentBlocks(finalRaw);
        const preferBackend = backendTextLen > existingTextLen
          || (backendTextLen === existingTextLen && backendBlocks.length >= existingBlocks.length);

        if (typeof params.backendRaw === 'object' && params.backendRaw !== null) {
          const backendObj = params.backendRaw as Record<string, unknown>;
          const currentObj = (finalRaw && typeof finalRaw === 'object' ? finalRaw : {}) as Record<string, unknown>;
          finalRaw = {
            ...(preferBackend ? backendObj : currentObj),
            ...(backendObj.turnUsage ? { turnUsage: backendObj.turnUsage } : {}),
            ...(backendObj.turnCostUsd !== undefined ? { turnCostUsd: backendObj.turnCostUsd } : {}),
            ...(backendObj.tokens ? { tokens: backendObj.tokens } : {}),
            ...(backendObj.durationMs !== undefined ? { durationMs: backendObj.durationMs } : {}),
          } as ClaudeMessage['raw'];
        } else if (preferBackend) {
          finalRaw = params.backendRaw as ClaudeMessage['raw'];
        }
      }
      const hasAnyContent = Boolean(
        (typeof finalContent === 'string' && finalContent.trim().length > 0)
        || rawHasContent(finalRaw),
      );
      if (!hasAnyContent) {
        list.splice(index, 1);
      } else {
        list[index] = {
          ...current,
          content: finalContent,
          raw: finalRaw,
          isStreaming: false,
          __turnId: params.turnId,
          ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
        };
      }
    }

    // Recover tool results that were in the pending snapshot but would be lost
    // when the rAF flush is cancelled: their cards would spin forever.
    if (params.pendingToolResults.length > 0) {
      const known = collectToolResultIds(list);
      for (const message of params.pendingToolResults) {
        const candidate = { ...message, type: 'user', timestamp: params.toolResultTimestamp } as ClaudeMessage;
        const ids = toolResultIdsOf(candidate);
        if (ids.some((id) => !known.has(id))) {
          list.push(candidate);
          for (const id of ids) known.add(id);
        }
      }
    }

    this.replaceRemote(rebuild(list));
    this.streamingTurnId = null;
  }

  // ── optimistic bubbles ───────────────────────────────────────────────────

  addLocal(clientId: string, message: ClaudeMessage): void {
    if (this.local.some((entry) => entry.clientId === clientId)) return;
    this.local.push({ clientId, message });
    this.snapshot = null;
  }

  confirmLocal(clientId: string, providerId?: string): void {
    const entry = this.local.find((candidate) => candidate.clientId === clientId);
    if (!entry) return;
    if (providerId) {
      entry.providerId = providerId;
    }
    // The confirmation is what turns the optimistic bubble into a remote one.
    if (providerId && !this.remoteArray().some((message) => providerIdOf(message) === providerId)) {
      this.local = this.local.filter((candidate) => candidate !== entry);
      this.replaceRemote([...this.remoteArray(), { ...entry.message, isOptimistic: false }]);
      return;
    }
    this.snapshot = null;
  }

  /** Drop a local bubble whose send failed or was cancelled. */
  removeLocal(clientId: string): void {
    const before = this.local.length;
    this.local = this.local.filter((entry) => entry.clientId !== clientId);
    if (this.local.length !== before) this.snapshot = null;
  }

  /** Is this snapshot sentence already represented, remote or local? */
  hasLocalMatching(content: string): boolean {
    return this.local.some((entry) => (entry.message.content ?? '') === content);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private remoteArray(): ClaudeMessage[] {
    const list: ClaudeMessage[] = [];
    for (const key of this.order) {
      const message = this.byId.get(key);
      if (message) list.push(message);
    }
    return list;
  }

  private replaceRemote(messages: ClaudeMessage[]): void {
    const nextOrder: string[] = [];
    const nextById = new Map<string, ClaudeMessage>();
    const seen = new Set<string>();
    messages.forEach((message, index) => {
      const key = messageKey(message, index);
      if (seen.has(key)) return;
      seen.add(key);
      nextOrder.push(key);
      nextById.set(key, message);
    });
    this.order = nextOrder;
    this.byId.clear();
    nextById.forEach((message, key) => this.byId.set(key, message));
    this.reconcileLocal();
    this.snapshot = null;
  }

  /**
   * Drop optimistic bubbles the host has now echoed.
   *
   * <p>The echo carries a different timestamp (and often no uuid yet), so
   * identity is the content of a user message, not its record id.</p>
   */
  private reconcileLocal(): void {
    if (this.local.length === 0) return;
    const remoteContent = new Set(
      this.remoteArray()
        .filter((message) => message.type === 'user')
        .map(contentKey),
    );
    this.local = this.local.filter((entry) => (
      entry.providerId != null
        ? !this.remoteArray().some((message) => providerIdOf(message) === entry.providerId)
        : !remoteContent.has(contentKey(entry.message))
    ));
  }

  private replaceMessageAt(index: number, message: ClaudeMessage): void {
    const key = this.order[index];
    if (!key) return;
    this.byId.set(key, message);
    this.snapshot = null;
  }

  private indexOfPending(): number {
    return this.order.length + this.local.length;
  }

  /**
   * Index of the first remote message after the newest compaction boundary.
   *
   * <p>Streaming lookups stop here: an assistant from before the boundary is
   * sealed and must never be patched, reclaimed or finalized again.</p>
   */
  private segmentStartIndex(): number {
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (this.byId.get(this.order[i])?.type === 'compaction') return i + 1;
    }
    return 0;
  }

  private lastRemoteAssistantIndex(): number {
    for (let i = this.order.length - 1; i >= this.segmentStartIndex(); i--) {
      if (this.byId.get(this.order[i])?.type === 'assistant') return i;
    }
    return -1;
  }


  private removeRemoteAt(index: number): void {
    const key = this.order[index];
    if (!key) return;
    this.order.splice(index, 1);
    this.byId.delete(key);
    this.snapshot = null;
  }

  private pushRemote(message: ClaudeMessage): void {
    const known = new Set(this.remoteArray().map(fingerprint));
    if (known.has(fingerprint(message))) {
      this.snapshot = null;
      return;
    }
    this.replaceRemote([...this.remoteArray(), message]);
  }
}

function hasContent(message: ClaudeMessage): boolean {
  if ((message.content ?? '').trim().length > 0) return true;
  const raw = message.raw as { message?: { content?: unknown } } | undefined;
  const content = raw?.message?.content;
  return Array.isArray(content) && content.length > 0;
}

/**
 * Index of the host snapshot's copy of the assistant that is still streaming.
 *
 * <p>The open turn is the newest one, so its assistant is the last assistant in
 * the snapshot. A snapshot that names a different turn is not a copy of this
 * bubble, and merging it would graft another turn's blocks onto this one.</p>
 */
function lastStreamingCopyIndex(messages: ClaudeMessage[], pending: ClaudeMessage): number {
  const boundary = lastCompactionIndex(messages);
  for (let i = messages.length - 1; i > boundary; i -= 1) {
    const message = messages[i];
    if (message?.type !== 'assistant') continue;
    const pendingTurn = pending.__turnId;
    const incomingTurn = message.__turnId;
    if (typeof pendingTurn === 'number' && typeof incomingTurn === 'number' && pendingTurn !== incomingTurn) {
      return -1;
    }
    return i;
  }
  return -1;
}

function contentKey(message: ClaudeMessage): string {
  return `${message.type}|${(message.content ?? '').trim().slice(0, 200)}`;
}

function providerIdOf(message: ClaudeMessage): string | null {
  const uuid = getRawUuid(message);
  return uuid ?? null;
}

/** Index of the newest compaction record, or -1. */
function lastCompactionIndex(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'compaction') return i;
  }
  return -1;
}

/** Index of the newest assistant strictly after `fromExclusive`, or -1. */
function lastAssistantIndexAfter(messages: ClaudeMessage[], fromExclusive: number): number {
  for (let i = messages.length - 1; i > fromExclusive; i -= 1) {
    if (messages[i]?.type === 'assistant') return i;
  }
  return -1;
}

/** Index of the newest assistant strictly before `beforeExclusive`, or -1. */
function lastAssistantIndexBefore(messages: ClaudeMessage[], beforeExclusive: number): number {
  for (let i = beforeExclusive - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'assistant') return i;
  }
  return -1;
}

function lastAssistantIndexIn(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'assistant') return i;
  }
  return -1;
}

/**
 * Merge a pre-compaction pending bubble into the host's copy of that assistant.
 *
 * <p>The host copy wins identity (provider id, structural blocks); only text and
 * raw blocks the webview saw first are carried over.</p>
 */
function mergePendingIntoHost(host: ClaudeMessage, pending: ClaudeMessage): ClaudeMessage {
  const hostContent = host.content ?? '';
  const pendingContent = pending.content ?? '';
  return {
    ...host,
    content: pendingContent.length > hostContent.length ? pendingContent : hostContent,
    raw: mergeRawBlocksDuringStreaming(host.raw, pending.raw) as ClaudeMessage['raw'],
  };
}
