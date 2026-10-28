import { useEffect, useRef } from 'react';
import type { Attachment } from '../types';
import { getTabStore } from '../../../store/tabStore';

export interface UsePerTabAttachmentsOptions {
  /** 当前输入框里的附件（未发送）。 */
  attachments: Attachment[];
  /** 写回附件列表。 */
  setAttachments: (next: Attachment[]) => void;
  /** 附件由父组件控制时，本 hook 不动它（保持既有行为）。 */
  isControlled: boolean;
  /** 当前会话 id：同一 tab 内换会话时，附件属于旧会话，必须清掉。 */
  currentSessionId: string | null;
  /** 清掉持久化草稿（会话切换时调用）。 */
  clearDraft?: () => void;
}

interface PreviousState {
  tabId: string | null;
  sessionId: string | null;
}

/**
 * 未发送的附件按 tab 保存（§10.10）。
 *
 * 之前的行为是「会话一变就清空附件」——用户在 A 里贴好图，切到 B 再切回来，
 * 附件已经没了。现在：
 *   - 切 tab：把当前附件存回旧 tab，再从新 tab 取回（各 tab 各存一份）；
 *   - 同一 tab 内换会话（加载历史等）：附件属于旧会话，照旧清空。
 *
 * 附件的字节由宿主按 tab 落盘（`TabAttachmentStore`），这里只保存输入框里的
 * 那份引用（文件名 / 类型 / data URL），不写 localStorage。
 */
export function usePerTabAttachments({
  attachments,
  setAttachments,
  isControlled,
  currentSessionId,
  clearDraft,
}: UsePerTabAttachmentsOptions): void {
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const previousRef = useRef<PreviousState | null>(null);
  /** 写 tab 记录会触发 store 通知 → 再进 apply；这里挡住重入。 */
  const applyingRef = useRef(false);

  useEffect(() => {
    const tabStore = getTabStore();

    const apply = () => {
      if (applyingRef.current) {
        return;
      }
      applyingRef.current = true;
      try {
        const activeTabId = tabStore.getActiveTabId();
        const previous = previousRef.current;

        if (!previous) {
          // 首次：只认领当前 tab（不动附件，避免盖掉持久化草稿的恢复）。
          previousRef.current = { tabId: activeTabId, sessionId: currentSessionId };
          return;
        }

        if (previous.tabId === activeTabId) {
          if (previous.sessionId !== currentSessionId) {
            // 同一 tab 内换了会话：附件属于旧会话，清掉。
            if (!isControlled) {
              setAttachments([]);
            }
            clearDraft?.();
          }
          previousRef.current = { tabId: activeTabId, sessionId: currentSessionId };
          return;
        }

        // 切 tab：旧 tab 存回当前附件，新 tab 取回它自己的。
        const snapshot = attachmentsRef.current;
        // 先更新状态再写 store：写 store 会同步触发通知，那时状态必须已是新的。
        previousRef.current = { tabId: activeTabId, sessionId: currentSessionId };
        if (previous.tabId) {
          tabStore.updateTab(previous.tabId, (tab) => ({
            ...tab,
            pendingAttachments: snapshot,
          }));
        }
        if (!isControlled) {
          const next = activeTabId
            ? tabStore.findById(activeTabId)?.pendingAttachments
            : undefined;
          setAttachments(next ? [...next] : []);
        }
      } finally {
        applyingRef.current = false;
      }
    };

    apply();
    return tabStore.subscribe(apply);
  }, [currentSessionId, isControlled, setAttachments, clearDraft]);
}
