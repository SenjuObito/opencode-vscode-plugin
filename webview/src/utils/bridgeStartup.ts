const BRIDGE_FAST_RETRY_ATTEMPTS = 50;
const BRIDGE_FAST_RETRY_INTERVAL_MS = 100;
const BRIDGE_SLOW_RETRY_INTERVAL_MS = 1000;

export function waitForBridge(callback: () => void): () => void {
  let attempt = 0;
  let completed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    completed = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    delete window.__ccgOnBridgeReady;
  };

  const check = () => {
    if (completed) {
      return;
    }
    attempt++;
    if (window.sendToJava) {
      completed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      delete window.__ccgOnBridgeReady;
      window.removeEventListener('pagehide', cancel);
      callback();
      return;
    }

    if (attempt === BRIDGE_FAST_RETRY_ATTEMPTS) {
      console.warn('[Main] Bridge startup is delayed; continuing low-frequency retries');
    }
    const retryInterval = attempt < BRIDGE_FAST_RETRY_ATTEMPTS
      ? BRIDGE_FAST_RETRY_INTERVAL_MS
      : BRIDGE_SLOW_RETRY_INTERVAL_MS;
    retryTimer = setTimeout(check, retryInterval);
  };

  window.__ccgOnBridgeReady = check;
  window.addEventListener('pagehide', cancel, { once: true });
  check();
  return cancel;
}
