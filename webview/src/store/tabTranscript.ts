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
  /**
   * Identity of the host record `pendingAssistant` stands for, or null when
   * the bubble was opened locally (a send of this webview, or a turn event
   * with no host record behind it yet).
   *
   * <p>With this key the bubble can be matched to the host's copy by identity
   * instead of by position or text, which is what makes "one reply, one
   * bubble" hold while a snapshot and a delta race.</p>
   */
  private pendingHostKey: string | null = null;
  private snapshot: ClaudeMessage[] | null = null;
  private streamingTurnId: number | null = null;
  /** Identity of the newest compaction record already observed. */
  private lastCompactionKey: string | null = null;
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
  applySnapshot(messages: ClaudeMessage[], baseIndex = 0, live: ClaudeMessage | null = null): void {
    const newBase = Number.isSafeInteger(baseIndex) && baseIndex >= 0 ? baseIndex : 0;
    const windowMessages = messages;

    // The host states which record it is still generating, and that record is
    // no longer part of the window. Nothing here has to guess it by position or
    // text any more — that guess is what put a second copy of the same reply on
    // screen.
    this.observeCompaction(messages);

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
    this.applyLiveDraft(live);
  }

  /**
   * Replace the tail of the host window.
   *
   * <p>`baseIndex` is the window-relative start of the tail. When it lies
   * inside the current window the prefix is kept; when the window slid past
   * it, only the older pages survive in front of the tail.</p>
   */
  applyTail(messages: ClaudeMessage[], baseIndex: number, live: ClaudeMessage | null = null): void {
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

    // A tail can carry a compaction record too (long conversations); the same
    // boundary rule as the snapshot applies.
    this.observeCompaction(messages);

    this.base = hasFullPrefix ? 0 : tailStart;
    this.replaceRemote([...headMessages, ...messages]);
    this.paged = Math.min(this.paged, headMessages.length);
    this.applyLiveDraft(live);
  }

  /**
   * Note a compaction boundary that appeared in a host frame.
   *
   * <p>A compaction record seals everything before it. The bubble that was
   * streaming when the boundary appeared belongs to the sealed segment, so the
   * view's delta buffers describe an old segment and must be dropped before the
   * next snapshot merges.</p>
   */
  private observeCompaction(messages: ClaudeMessage[]): void {
    const index = lastCompactionIndex(messages);
    if (index < 0) return;
    const key = draftKeyOf(messages[index]);
    if (key === this.lastCompactionKey) return;
    this.lastCompactionKey = key;
    if (!this.pendingAssistant) return;
    this.compactionBoundaryCrossed = true;
  }

  /**
   * Apply the host's statement about the record it is still generating.
   *
   * <p>`live` is that record (still being written), or null when the host has
   * nothing in flight. This is the transcript's only way to learn about a turn
   * it did not start itself, and the only place a streaming bubble is created
   * for one — no position or text heuristics involved.</p>
   *
   * <p>Three cases:</p>
   * <ul>
   *   <li>null — the bubble is history now: move it into the remote list by
   *       identity.</li>
   *   <li>the record is already in the remote list — a late copy; the confirmed
   *       entry owns the bubble.</li>
   *   <li>otherwise — adopt the host's copy as the open bubble, keeping whatever
   *       text the view already received through the delta channel.</li>
   * </ul>
   */
  applyLiveDraft(live: ClaudeMessage | null): void {
    if (!live) {
      this.commitPendingToHost();
      return;
    }
    const key = draftKeyOf(live);
    if (this.indexOfDraftHost(key) >= 0) {
      this.commitPendingToHost();
      return;
    }
    const pending = this.pendingAssistant;
    const pendingKey = this.pendingHostKey;
    if (pending && pendingKey && !draftKeysCompatible(pendingKey, key)) {
      // A different record is in flight now: the old bubble is history.
      this.commitPendingToHost();
    }
    const current = this.pendingAssistant;
    // The host copy wins structure (tool blocks, ids); the view keeps whichever
    // text is further ahead because the delta channel can lead the snapshot.
    this.pendingAssistant = current
      ? { ...mergeHostDraft(live, current), isStreaming: true }
      : { ...live, isStreaming: true };
    this.pendingHostKey = key;
    this.snapshot = null;
  }

  /**
   * Drop the draft segment by moving its bubble into the confirmed list.
   *
   * <p>Identity decides where it goes. When the host already has the record in
   * the list, the bubble merges into that entry instead of being appended
   * again — the exact case that used to render the same reply twice.</p>
   */
  private commitPendingToHost(): void {
    const pending = this.pendingAssistant;
    const key = this.pendingHostKey;
    if (!pending) {
      this.pendingHostKey = null;
      return;
    }
    this.pendingAssistant = null;
    this.pendingHostKey = null;
    this.snapshot = null;

    // The turn id is the transcript's own notion of "the open turn"; a bubble
    // adopted from the host draft never learned it, so stamp it here. Settling
    // paths look the record up by that id right after this.
    const turnId = this.streamingTurnId;
    const settle = (message: ClaudeMessage): ClaudeMessage => ({
      ...message,
      isStreaming: false,
      ...(message.__turnId == null && turnId != null ? { __turnId: turnId } : {}),
    });

    const list = this.remoteArray();
    const hostIndex = key ? this.indexOfDraftHost(key) : this.lastStreamingRemoteAssistantIndex();
    if (hostIndex < 0) {
      list.push(settle(pending));
      this.replaceRemote(list);
      return;
    }
    list[hostIndex] = settle(mergeHostDraft(list[hostIndex], pending));
    this.replaceRemote(list);
  }

  /** Index of the host's copy of a draft record, or -1. */
  private indexOfDraftHost(key: string): number {
    if (!key) return -1;
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const message = this.byId.get(this.order[i]);
      if (message && draftKeyOf(message) === key) return i;
    }
    return -1;
  }

  /**
   * Newest assistant of the open segment the host has already placed in the
   * list, or -1. Only used for a bubble with no host identity (a locally
   * started turn), and only when the host marked it streaming.
   */
  private lastStreamingRemoteAssistantIndex(): number {
    for (let i = this.order.length - 1; i >= this.segmentStartIndex(); i -= 1) {
      const message = this.byId.get(this.order[i]);
      if (message?.type === 'assistant' && message.isStreaming === true) return i;
    }
    return -1;
  }

  /** Drop every per-turn streaming marker (used by `clear`). */
  private resetStreamingMarkers(): void {
    this.pendingAssistant = null;
    this.pendingHostKey = null;
    this.streamingTurnId = null;
    this.compactionBoundaryCrossed = false;
    this.lastCompactionKey = null;
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
      if (providerId && removed.has(providerId)) {
        this.pendingAssistant = null;
        this.pendingHostKey = null;
      }
    }
    this.replaceRemote(next);
  }

  clear(): void {
    this.local = [];
    this.resetStreamingMarkers();
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

    // A bubble the host already announced through the draft channel is this
    // turn's bubble: it only lacked the turn id. Reusing it keeps one bubble
    // per reply even when the turn event arrives after the first frame.
    if (pending && this.pendingHostKey) {
      this.pendingAssistant = { ...pending, isStreaming: true, __turnId: turnId };
      return this.indexOfPending();
    }

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
    // A bubble adopted from the host's draft carries no turn id yet: it is
    // still the open turn, so a patch aimed at that turn must land on it.
    if (pending && (turnId == null || pending.__turnId == null || pending.__turnId === turnId)) {
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
    // The draft joins the confirmed list by identity; when the host already put
    // the same record there this merges into it instead of appending a copy.
    if (this.pendingAssistant) {
      this.commitPendingToHost();
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
    if (pending && (turnId == null || pending.__turnId == null || pending.__turnId === turnId)) {
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

    if (pending && (params.turnId <= 0 || pending.__turnId == null || pending.__turnId === params.turnId)) {
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
}

function hasContent(message: ClaudeMessage): boolean {
  if ((message.content ?? '').trim().length > 0) return true;
  const raw = message.raw as { message?: { content?: unknown } } | undefined;
  const content = raw?.message?.content;
  return Array.isArray(content) && content.length > 0;
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

/**
 * Identity of a record as both sides know it: type plus provider id.
 *
 * <p>Timestamps are the fallback only when a record carries no id (optimistic
 * bubbles, partially parsed rows). The host and the view serialise the same
 * record, so the fallback agrees on both sides; it is never used to *guess*
 * that two different records are the same.</p>
 */
export function draftKeyOf(message: ClaudeMessage): string {
  const uuid = getRawUuid(message);
  if (uuid) return `${message.type}\u0000${uuid}`;
  return `${message.type}\u0000${message.timestamp ?? ''}`;
}

/** Whether two draft identities denote the same record. */
function draftKeysCompatible(a: string, b: string): boolean {
  return a.length > 0 && a === b;
}

/**
 * Merge a bubble into the host's copy of the same record.
 *
 * <p>The host copy wins identity (provider id, structural blocks); only text and
 * raw blocks the view saw first are carried over. The delta channel can lead
 * the coalesced frame, so the longer text is the more recent one.</p>
 */
function mergeHostDraft(host: ClaudeMessage, bubble: ClaudeMessage): ClaudeMessage {
  const hostContent = host.content ?? '';
  const bubbleContent = bubble.content ?? '';
  return {
    ...host,
    ...(typeof bubble.__turnId === 'number' ? { __turnId: bubble.__turnId } : {}),
    content: bubbleContent.length > hostContent.length ? bubbleContent : hostContent,
    // `mergeRawBlocksDuringStreaming(prev, next)` takes structure from `next`
    // and longer text from `prev`: the host owns the blocks, the bubble may be
    // ahead on text because the delta channel runs on its own clock.
    raw: mergeRawBlocksDuringStreaming(bubble.raw, host.raw) as ClaudeMessage['raw'],
  };
}
