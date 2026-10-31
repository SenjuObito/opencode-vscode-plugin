import { useCallback, useSyncExternalStore } from 'react';
import { getTabStore } from '../store/tabStore';
import { EMPTY_TAB_QUEUE } from '../store/tabQueueStore';
import type { QueuedMessage, TabQueueErrorView, TabQueueSnapshot } from '../store/tabQueueStore';
import { sendTabCommand } from '../utils/bridge';
import type { UploadedAttachment } from '../utils/attachmentTransport';
import type { PermissionMode, ReasoningEffort } from '../components/ChatInputBox/types';

export type { QueuedMessage, TabQueueErrorView, TabQueueSnapshot };

/**
 * A send frozen by the view before handing it to the host.
 *
 * <p>Everything the send needs travels with the item: the host must never
 * re-read the active tab's model/mode/attachments, which is exactly how the
 * old global queue delivered A's message to B.</p>
 */
export interface EnqueueMessageInput {
  content: string;
  /** Already uploaded under the *active* tab. */
  attachments?: UploadedAttachment[];
  fileTags?: Array<{ displayPath: string; absolutePath: string }>;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface UseMessageQueueReturn {
  /** Items waiting for their turn. The one being sent is not part of it. */
  queue: QueuedMessage[];
  /** True after a stop: the host waits for an explicit resume. */
  paused: boolean;
  /** Last send failure of an item that was put back at the head. */
  lastError: TabQueueErrorView | null;
  /** Hand a frozen message to the host. Returns false when there is no tab. */
  enqueue: (input: EnqueueMessageInput) => boolean;
  /**
   * Hand a builtin session command to the same FIFO as the user's prompts.
   * `args` freezes what the command must act on (the undo target message, the
   * tab a fork will open in) at enqueue time.
   */
  enqueueCommand: (command: string, args?: EnqueueCommandArgs) => boolean;
  dequeue: (id: string) => void;
  clearQueue: () => void;
  resumeQueue: () => void;
}

/** Context a queued command needs when it finally runs. */
export interface EnqueueCommandArgs {
  /** `/undo`: the user message that was newest when the command was queued. */
  messageId?: string;
  /** `/fork`: the tab the forked session will be bound to. */
  targetTabId?: string;
  /** `/compact`: the model frozen with the command when it was queued. */
  model?: string | null;
}

function createQueueId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `queue-${crypto.randomUUID()}`;
  }
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The active tab's queue projection.
 *
 * <p>There is deliberately no timer, no loading transition and no send here:
 * the host owns the queue and the single consumer. The webview only sends
 * commands and renders the snapshot the host pushes. Switching tabs therefore
 * changes what is displayed, never what is sent.</p>
 */
export function useMessageQueue(): UseMessageQueueReturn {
  const store = getTabStore();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.getActiveTab().queue ?? EMPTY_TAB_QUEUE,
    () => EMPTY_TAB_QUEUE,
  );

  const enqueue = useCallback((input: EnqueueMessageInput): boolean => {
    const tabId = store.getActiveTabId();
    if (!tabId) {
      return false;
    }
    const text = input.content ?? '';
    const attachments = input.attachments ?? [];
    if (!text.trim() && attachments.length === 0) {
      return false;
    }
    return sendTabCommand(tabId, 'queue.enqueue', {
      item: {
        id: createQueueId(),
        text,
        attachments,
        fileTags: input.fileTags ?? [],
        model: input.model ?? null,
        permissionMode: input.permissionMode ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        createdAt: Date.now(),
      },
    });
  }, [store]);

  const enqueueCommand = useCallback((command: string, args?: EnqueueCommandArgs): boolean => {
    const tabId = store.getActiveTabId();
    if (!tabId || !command) {
      return false;
    }
    return sendTabCommand(tabId, 'queue.enqueue', {
      item: {
        id: createQueueId(),
        text: command,
        command,
        commandArgs: args ?? {},
        // `/compact` freezes the model with the command; the host never
        // re-reads the tab's current model when the item finally runs.
        model: args?.model ?? null,
        attachments: [],
        fileTags: [],
        createdAt: Date.now(),
      },
    });
  }, [store]);

  const dequeue = useCallback((id: string) => {
    const tabId = store.getActiveTabId();
    if (!tabId || !id) {
      return;
    }
    sendTabCommand(tabId, 'queue.remove', { itemId: id });
  }, [store]);

  const clearQueue = useCallback(() => {
    const tabId = store.getActiveTabId();
    if (!tabId) {
      return;
    }
    sendTabCommand(tabId, 'queue.clear', {});
  }, [store]);

  const resumeQueue = useCallback(() => {
    const tabId = store.getActiveTabId();
    if (!tabId) {
      return;
    }
    sendTabCommand(tabId, 'queue.resume', {});
  }, [store]);

  return {
    queue: snapshot.items,
    paused: snapshot.paused,
    lastError: snapshot.lastError,
    enqueue,
    enqueueCommand,
    dequeue,
    clearQueue,
    resumeQueue,
  };
}
