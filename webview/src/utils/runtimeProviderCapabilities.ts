/**
 * Runtime provider capabilities subscriber registry.
 *
 * The Java bridge invokes `window.updateActiveCodexProvider` to deliver the
 * active Codex provider; useCliModels reacts to it by dropping its cached
 * catalog. Registering a single dispatcher on `window` and routing events
 * through a subscriber Set keeps behavior deterministic regardless of mount
 * order, and avoids the previous "chain of overridden window callbacks"
 * pattern, which produced non-deterministic teardown when more than one
 * consumer was alive.
 *
 * NOTE: `window.updateActiveProvider` is intentionally NOT installed here.
 * It is owned by usageModeCallbacks (App), which syncs the active provider
 * config into React state. An earlier version of this module installed that
 * callback too, so whichever ran last silently won and the App handler could
 * be clobbered. Only the Codex callback is routed through the registry now.
 */

type ActiveProviderListener = (json: string) => void;

const activeCodexProviderListeners = new Set<ActiveProviderListener>();

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  // Snapshot to avoid mutation during iteration.
  Array.from(listeners).forEach((listener) => {
    try {
      listener(value);
    } catch (error) {
      console.error('[runtimeProviderCapabilities] Listener threw:', error);
    }
  });
}

/**
 * Installs (or re-installs) the dispatcher on `window`. Safe to call
 * multiple times — calling it during a test reset, for example, simply
 * re-attaches the dispatcher.
 */
export function installRuntimeProviderDispatchers(): void {
  window.updateActiveCodexProvider = (json: string) => {
    emit(activeCodexProviderListeners, json);
  };
}

function ensureInstalled(): void {
  // The dispatcher is cheap to (re)install — make subscription self-bootstrapping
  // so that consumers do not depend on a separate bootstrap call.
  if (typeof window === 'undefined') return;
  if (window.updateActiveCodexProvider) {
    return;
  }
  installRuntimeProviderDispatchers();
}

export function subscribeActiveCodexProvider(listener: ActiveProviderListener): () => void {
  ensureInstalled();
  activeCodexProviderListeners.add(listener);
  return () => {
    activeCodexProviderListeners.delete(listener);
  };
}
