/**
 * VS Code webview API globals.
 *
 * `acquireVsCodeApi` is injected by the VS Code webview host; it is a global
 * function available in the webview's JS context (not part of any package).
 */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
