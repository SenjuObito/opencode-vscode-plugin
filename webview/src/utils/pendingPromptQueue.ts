/**
 * 未决 prompt 的按 tab 队列。
 *
 * 多 tab 后一个 webview 只有一套对话框：后台 tab 的权限/提问请求如果立刻弹出来，
 * 会打断用户正在看的那个对话（也会把答复错发给当前 tab 的卡片）。所以：
 *
 * - 请求带着 `tabId`（宿主 `PermissionHandler` 会盖）且不是活跃 tab → 先入队，
 *   并在该 tab 上点亮"等待操作"角标；
 * - 切到那个 tab 时（`flushQueuedPrompts`）再把请求交给对话框。
 *
 * 纯函数 + 一个 Map，便于单测；不依赖 React。
 */
import { getTabStore } from '../store/tabStore';

export type QueuedPromptKind = 'permission' | 'question' | 'plan';

export interface QueuedPrompt {
  kind: QueuedPromptKind;
  tabId: string;
  request: Record<string, unknown>;
}

const queue = new Map<string, QueuedPrompt[]>();

/** 入队，并把"等待操作"标记写到该 tab 上（tab 栏据此显示角标）。 */
export function enqueuePrompt(prompt: QueuedPrompt): void {
  if (!prompt?.tabId) {
    return;
  }
  const list = queue.get(prompt.tabId) ?? [];
  list.push(prompt);
  queue.set(prompt.tabId, list);
  markTabPending(prompt.tabId, prompt.kind, prompt.request, true);
}

/** 取走某个 tab 的全部排队 prompt（调用方负责真正弹出）。 */
export function drainPromptsForTab(tabId: string | null | undefined): QueuedPrompt[] {
  if (!tabId) {
    return [];
  }
  const list = queue.get(tabId) ?? [];
  queue.delete(tabId);
  for (const prompt of list) {
    markTabPending(tabId, prompt.kind, prompt.request, false);
  }
  return list;
}

export function pendingPromptCount(tabId: string | null | undefined): number {
  if (!tabId) {
    return 0;
  }
  return queue.get(tabId)?.length ?? 0;
}

/**
 * 宿主已关闭某个 prompt（服务端答复/超时/关 tab）：把它从队列里摘掉。
 * 不摘的话，切回该 tab 时会弹一张已经失效的卡片。
 */
export function removeQueuedPrompt(kind: QueuedPromptKind, key: string): void {
  if (!key) {
    return;
  }
  for (const [tabId, list] of [...queue.entries()]) {
    const kept = list.filter((prompt) => {
      if (prompt.kind !== kind) {
        return true;
      }
      const record = prompt.request;
      return String(record?.channelId ?? record?.requestId ?? '') !== key;
    });
    if (kept.length === 0) {
      queue.delete(tabId);
    } else {
      queue.set(tabId, kept);
    }
  }
}

/** 测试用：清空队列（不动 tab 上的标记）。 */
export function resetPendingPromptQueue(): void {
  queue.clear();
}

const FIELD_BY_KIND: Record<QueuedPromptKind, 'pendingPermissions' | 'pendingQuestions' | 'pendingPlans'> = {
  permission: 'pendingPermissions',
  question: 'pendingQuestions',
  plan: 'pendingPlans',
};

function markTabPending(
  tabId: string,
  kind: QueuedPromptKind,
  request: Record<string, unknown>,
  present: boolean,
): void {
  const field = FIELD_BY_KIND[kind];
  const key = String(request.channelId ?? request.requestId ?? '');
  try {
    getTabStore().updateTab(tabId, (tab) => {
      const current = (tab[field] as unknown[] | undefined) ?? [];
      const next = present
        ? [...current, request]
        : current.filter((item) => {
          const record = item as Record<string, unknown>;
          return String(record?.channelId ?? record?.requestId ?? '') !== key;
        });
      // updateTab 允许直接改它给的那份拷贝
      (tab as unknown as Record<string, unknown>)[field] = next;
    });
  } catch {
    // tab 已不在（关掉了）：标记没有意义，队列本身也会随 tab 关闭被丢弃
  }
}
