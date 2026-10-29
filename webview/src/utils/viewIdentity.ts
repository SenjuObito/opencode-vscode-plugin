/**
 * View identity & prompt-host election.
 *
 * <p>宿主的每个 webview 都带一个 `window.__VIEW_ID__`（侧边栏 / 编辑器 panel /
 * 辅助侧边栏）。同一时刻只有一个视图负责渲染交互式 prompt（权限、提问、计划），
 * 其余视图只显示 tab 上的等待徽标。宿主在选举变化时广播
 * `prompt.host.changed`。</p>
 *
 * <p>单视图环境（没有注入 viewId，或宿主还没广播）默认自己就是 prompt host，
 * 这样旧行为不会因为多视图改造而退化。</p>
 */

declare global {
  interface Window {
    __VIEW_ID__?: string;
  }
}

let promptHostViewId: string | null = null;
const listeners = new Set<() => void>();

/** 当前 webview 的视图 id；旧宿主/单测环境为空字符串。 */
export function getViewId(): string {
  return typeof window !== 'undefined' ? (window.__VIEW_ID__ ?? '') : '';
}

/** 宿主选出的 prompt host（null 表示尚未收到选举结果）。 */
export function setPromptHostViewId(viewId: string | null): void {
  if (promptHostViewId === viewId) {
    return;
  }
  promptHostViewId = viewId;
  for (const listener of listeners) {
    listener();
  }
}

export function getPromptHostViewId(): string | null {
  return promptHostViewId;
}

/**
 * 本视图是否应渲染交互式 prompt。
 *
 * <p>没有视图 id（单视图 / 测试）恒为 true；有 id 但宿主尚未选举也先按 true，
 * 避免启动瞬间把弹窗丢掉。</p>
 */
export function isPromptHost(): boolean {
  const viewId = getViewId();
  if (!viewId || !promptHostViewId) {
    return true;
  }
  return promptHostViewId === viewId;
}

export function subscribePromptHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
