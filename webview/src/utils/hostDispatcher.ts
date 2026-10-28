/**
 * Unified host -> webview event dispatcher.
 *
 * The Java bridge used to invoke `window.<fn>` directly. That works only when
 * the callback is already registered; during app boot (or after a reload) the
 * first host events arrived before React mounted and were silently dropped.
 *
 * Every host event now goes through this single entry point. Unknown events are
 * queued until their handler appears, then flushed in arrival order. The
 * registry is the only routing table; there is no direct `window.<fn>` path.
 */

import { hostEventHandler } from './hostEventRegistry';

interface PendingHostEvent {
  type: string;
  args: unknown[];
  queuedAt: number;
}

interface HostEnvelope {
  v?: number;
  type?: string;
  tabId?: string;
  epoch?: number;
  payload?: { args?: unknown[] } | unknown[];
}

const MAX_PENDING_HOST_EVENTS = 2_000;
const MAX_QUEUE_AGE_MS = 30_000;
const FLUSH_INTERVAL_MS = 50;

const pending: PendingHostEvent[] = [];
const lastEpochByTab = new Map<string, number>();
let flushTimer: number | null = null;

function resolveHandler(type: string): ((...args: unknown[]) => void) | null {
  if (!type) return null;
  // The registry is the only routing table. An event whose handler is not
  // registered yet stays queued; an event whose handler never registers is
  // dropped. There is no `window.<fn>` fallback.
  return hostEventHandler(type);
}

function scheduleFlush(): void {
  if (typeof window === 'undefined' || flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushHostDispatcher();
  }, FLUSH_INTERVAL_MS);
}

export function flushHostDispatcher(): void {
  if (typeof window === 'undefined') {
    pending.length = 0;
    return;
  }
  const now = Date.now();
  for (let i = 0; i < pending.length;) {
    const event = pending[i];
    if (now - event.queuedAt > MAX_QUEUE_AGE_MS) {
      pending.splice(i, 1);
      continue;
    }
    const handler = resolveHandler(event.type);
    if (!handler) {
      i += 1;
      continue;
    }
    pending.splice(i, 1);
    try {
      handler.apply(window, event.args);
    } catch (error) {
      console.error(`[HostDispatcher] ${event.type} handler error:`, error);
    }
  }
  if (pending.length > 0) {
    scheduleFlush();
  }
}

export function dispatchHostEvent(type: string, args: unknown[] = []): void {
  if (!type || typeof window === 'undefined') return;
  const handler = resolveHandler(type);
  if (handler) {
    try {
      handler.apply(window, args);
    } catch (error) {
      console.error(`[HostDispatcher] ${type} handler error:`, error);
    }
    return;
  }
  if (pending.length >= MAX_PENDING_HOST_EVENTS) {
    pending.shift();
  }
  pending.push({ type, args, queuedAt: Date.now() });
  scheduleFlush();
}

export function pendingHostEventCount(): number {
  return pending.length;
}

/** Test hook: clear the queue, epochs, and the scheduled flush. */
export function resetHostDispatcher(): void {
  pending.length = 0;
  lastEpochByTab.clear();
  if (flushTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * Apply one typed host envelope.
 *
 * `tabId` + `epoch` let the dispatcher reject an event produced for an older
 * binding of the same tab (a late snapshot from before a rebind must not
 * repaint the new session). Events without an epoch keep legacy semantics.
 */
export function dispatchHostEnvelope(envelope: HostEnvelope): void {
  if (!envelope || typeof envelope.type !== 'string' || !envelope.type) return;

  if (envelope.tabId) {
    const epoch = typeof envelope.epoch === 'number' ? envelope.epoch : 0;
    const last = lastEpochByTab.get(envelope.tabId) ?? -1;
    if (epoch > 0 && epoch < last) {
      return;
    }
    if (epoch > last) {
      lastEpochByTab.set(envelope.tabId, epoch);
    }
  }

  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && !('args' in (payload as Record<string, unknown>))) {
    const record = payload as Record<string, unknown>;
    // Legacy callbacks such as `daemon.status` / `agents.updated` carried one
    // JSON string. The named-event migration wraps it as `{ data: "..." }`;
    // unwrap a single data field so both old string handlers and new named
    // handlers see the shape they were written for.
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record.data === 'string') {
      dispatchHostEvent(envelope.type, [record.data, envelope]);
      return;
    }
    // A named event: the handler reads the payload by field name and the
    // envelope for the identity.
    dispatchHostEvent(envelope.type, [payload, envelope]);
    return;
  }
  let args: unknown[] = [];
  if (Array.isArray(payload)) {
    args = payload;
  } else if (payload && typeof payload === 'object') {
    const candidate = (payload as { args?: unknown }).args;
    if (Array.isArray(candidate)) args = candidate;
  }
  dispatchHostEvent(envelope.type, args);
}

export function dispatchHostEnvelopeBatch(batch: unknown): void {
  if (!Array.isArray(batch)) return;
  for (const envelope of batch) {
    try {
      dispatchHostEnvelope(envelope as HostEnvelope);
    } catch (error) {
      console.error('[HostDispatcher] envelope failed:', error);
    }
  }
}

/** Test hook: forget per-tab epochs. */
export function resetHostDispatcherEpochs(): void {
  lastEpochByTab.clear();
}

/**
 * Trust the host's current epoch for a tab. Used after a reload resync so a
 * delayed event from before the reload is rejected instead of repainting.
 */
export function observeHostEpoch(tabId: string, epoch: number): void {
  if (!tabId || !Number.isFinite(epoch) || epoch <= 0) return;
  const last = lastEpochByTab.get(tabId) ?? -1;
  if (epoch > last) {
    lastEpochByTab.set(tabId, epoch);
  }
}

declare global {
  interface Window {
    __opencodeDispatch?: (type: string, args?: unknown[]) => void;
    __opencodeDispatchBatch?: (batch: unknown) => void;
    __flushOpencodeDispatch?: () => void;
  }
}

window.__opencodeDispatch = dispatchHostEvent;
window.__opencodeDispatchBatch = dispatchHostEnvelopeBatch;
window.__flushOpencodeDispatch = flushHostDispatcher;
