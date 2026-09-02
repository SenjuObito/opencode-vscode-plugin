/**
 * Shared AsyncLocalStorage context for per-request stdout/stderr attribution.
 *
 * daemon.js uses this to tag output lines with the active request id.
 * opencode-daemon-service.js uses it to detach the long-lived SSE event loop
 * from the request that created it, so SSE events fall back to the active turn
 * id instead of being pinned to a stale request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
