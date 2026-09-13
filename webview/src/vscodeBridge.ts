/**
 * vscodeBridge.ts
 *
 * VS Code 适配层 —— 把 cc-gui webview 的 JCEF 桥换成 acquireVsCodeApi。
 *
 * 出站（webview → host）：JCEF 里注入 `window.sendToJava(payload)`，payload 是
 *   `"type:content"` 字符串。这里把 `window.sendToJava` 重定义为
 *   `vscode.postMessage({ type: 'bridge', payload })`，扩展宿主侧按同样的
 *   `"type:content"` 协议解析 —— webview 内部 bridge.ts / 组件代码零改动。
 *
 * 入站（host → webview）：JCEF 里 Java 通过 executeJavaScript 调用
 *   `window.<fn>(...args)`。这里统一监听 `message`，宿主 post
 *   `{ type: '<fnName>', args: [...] }` 即调用 `window[fnName](...args)`。
 *   `window.*` 函数仍由 registerCallbacks 等原有机制挂载。
 *
 * 本模块必须在 React 渲染前 import（放在 main.tsx 顶部），保证
 *   `waitForBridge` 能立即感知到桥已就绪。
 */

interface VSCodeWebviewApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

// acquireVsCodeApi() 每个 webview 只允许调用一次 —— 模块级调用。
// 仅存在于 VS Code webview 宿主；IntelliJ JCEF 宿主没有这个全局函数，
// 此时改用桥兜底：postMessage 转发到宿主注入的原生 window.sendToJava，
// 并且不抢注 JS 版 sendToJava，让 waitForBridge 等到原生桥就绪。
const isVsCodeHost = typeof acquireVsCodeApi === 'function';

const jcefApi: VSCodeWebviewApi = {
  postMessage(message: unknown): void {
    if (typeof window.sendToJava === 'function') {
      window.sendToJava(typeof message === 'string' ? message : JSON.stringify(message));
    } else {
      console.error('[vscodeBridge] postMessage dropped: native bridge not ready');
    }
  },
};

const vscodeApi: VSCodeWebviewApi = isVsCodeHost ? acquireVsCodeApi() : jcefApi;

/** 宿主 → webview 的统一入站消息格式。 */
export interface HostToWebviewMessage {
  type: string;
  args?: unknown[];
}

/** 出站：保持 cc-gui 的 `"type:content"` 字符串协议原样传给宿主。 */
export function postToHost(payload: string): void {
  console.error(`[vscodeBridge] postToHost: payload=${payload.substring(0, 150)}`);
  vscodeApi.postMessage({ type: 'bridge', payload });
}

/** 入站：把宿主消息分发给 window.<fn>。 */
function dispatchHostMessage(message: unknown): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  const { type, args } = message as HostToWebviewMessage;
  if (typeof type !== 'string' || !type) {
    return;
  }
  if (type === 'onTodoUpdated') {
    console.error('[vscodeBridge] dispatchHostMessage: onTodoUpdated received, args length:', args?.length);
  }
  const fn = (window as unknown as Record<string, unknown>)[type];
  if (typeof fn === 'function') {
    try {
      (fn as (...rest: unknown[]) => void).apply(window, Array.isArray(args) ? args : []);
    } catch (err) {
      console.error(`[vscode-bridge] ${type} handler error:`, err);
    }
  } else {
    if (type === 'onTodoUpdated') {
      console.error('[vscodeBridge] dispatchHostMessage: onTodoUpdated handler NOT found on window');
    }
  }
}

// ── 安装桥 ───────────────────────────────────────────────────────────────

// 出站注入（在 React / bridgeStartup 的 waitForBridge 轮询之前就位）。
// 仅 VS Code 宿主需要：JCEF 宿主的 window.sendToJava 由 Java 原生注入，
// 这里抢注会把消息绕回 jcefApi 造成递归，且让 waitForBridge 提前误判桥就绪。
if (isVsCodeHost && !window.sendToJava) {
  window.sendToJava = (payload: string) => {
    postToHost(String(payload));
  };
}

// 页面上下文就绪：VS Code 下桥在模块加载时同步建立（cc-gui/JCEF 由宿主
// 注入 HTML 时置位；这里补上等价语义），放行 useModelStatePersistence 的
// localStorage 持久化门禁——否则模型 / 模式 / 推理力度选择永远不落盘。
window.__CCGUI_PAGE_CONTEXT_READY__ = true;

// 入站分发（模块加载即监听）。
window.addEventListener('message', (event: MessageEvent) => {
  dispatchHostMessage(event.data);
});

// 保留引用以便宿主注入的 `ready` 握手之外的扩展能力；对外暴露一次调用。
export const vscode = vscodeApi;
