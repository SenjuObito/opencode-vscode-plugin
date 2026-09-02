/**
 * Shared types for the extension host (VS Code) — the TS rewrite of cc-gui's
 * Java backend. Message protocol follows cc-gui exactly so the copied webview
 * works unchanged:
 *
 * webview → host: `postMessage({ type: 'bridge', payload: '<type>:<content>' })`
 *   (payload is cc-gui's `"type:content"` wire format; parsed by the router)
 *
 * host → webview: `postMessage({ type: '<fnName>', args: [...] })`
 *   (the webview's vscodeBridge.ts dispatches to window.<fnName>(...args))
 */

/** Which VS Code panel this provider lives in. */
export type ViewHost = 'left' | 'right';

/** Webview → host message, before parsing the `type:content` payload. */
export interface BridgeMessage {
	type: 'bridge';
	payload: string;
}

/** Host → webview message (dispatched by vscodeBridge.ts to window.<fn>). */
export interface HostToWebviewMessage {
	type: string;
	args: unknown[];
}

/** One conversation message in cc-gui's transport format. */
export interface SessionMessage {
	type: string;
	timestamp: number;
	content: string;
	raw?: unknown;
}
