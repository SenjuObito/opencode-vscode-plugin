/**
 * The host event registry.
 *
 * <p>The host names its events semantically ({@code content.delta},
 * {@code message.snapshot}, …). The registry is the table that says which
 * handler answers which event, and the dispatcher reads it. The catalog keeps
 * the host and webview names in sync; routing itself goes through this table.</p>
 */
/**
 * A host event handler.
 *
 * <p>The handlers have their own argument shapes (a session id and a payload,
 * a request id and a decision, …); the registry only forwards them.</p>
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostEventHandler = (...args: any[]) => void;

const handlers = new Map<string, HostEventHandler>();

/**
 * Register the handlers of a batch of semantic events.
 *
 * <p>Entries without a handler are skipped: a module may register only the
 * events it implements, and the rest stay unknown to the dispatcher (which
 * drops them, as an unattributed event must be dropped).</p>
 */
export function registerHostEvents(events: Record<string, HostEventHandler | undefined>): void {
  for (const [type, handler] of Object.entries(events)) {
    if (typeof handler === 'function') {
      handlers.set(type, handler);
    }
  }
}

/** The handler of a semantic event type, or {@code null}. */
export function hostEventHandler(type: string): HostEventHandler | null {
  return handlers.get(type) ?? null;
}

/** Drop the registry entries of the given semantic event types. */
export function unregisterHostEvents(types: readonly string[]): void {
  for (const type of types) {
    handlers.delete(type);
  }
}

/** How many event types are registered. */
export function hostEventCount(): number {
  return handlers.size;
}

/** Drop every registration (tests). */
export function resetHostEvents(): void {
  handlers.clear();
}
