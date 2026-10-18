import { useImperativeHandle } from 'react';
import type { ForwardedRef, MutableRefObject } from 'react';
import type { Attachment, ChatInputBoxHandle, FileTagInfo } from '../types.js';
import { hasQuoteToken } from '../utils/quoteRegistry.js';

export interface UseChatInputImperativeHandleOptions {
  ref: ForwardedRef<ChatInputBoxHandle>;
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  invalidateCache: () => void;
  isExternalUpdateRef: MutableRefObject<boolean>;
  setHasContent: (hasContent: boolean) => void;
  adjustHeight: () => void;
  focusInput: () => void;
  clearInput: () => void;
  hasContent: boolean;
  extractFileTags: () => FileTagInfo[];
  /** Current attachment list (uncontrolled mode keeps it inside this component). */
  attachments: Attachment[];
  /** Replace the attachment list when a tab switch restores its draft. */
  setAttachments: (attachments: Attachment[]) => void;
  /** Re-apply file tags after the raw text was restored. */
  restoreFileTags: (tags: FileTagInfo[]) => void;
  /** Extract quotes map currently present in input */
  getQuotes?: () => Record<string, { text: string }>;
  /** Re-register quotes into registry and convert tokens to quote chips */
  restoreQuoteTags?: (quotes?: Record<string, { text: string }>) => void;
  /** Convert quote tokens in DOM to chip elements */
  renderQuoteTags?: () => void;
}

/**
 * useChatInputImperativeHandle - Exposes an imperative API for the input box
 *
 * Keeps the parent API stable without forcing additional re-renders.
 */
export function useChatInputImperativeHandle({
  ref,
  editableRef,
  getTextContent,
  invalidateCache,
  isExternalUpdateRef,
  setHasContent,
  adjustHeight,
  focusInput,
  clearInput,
  hasContent,
  extractFileTags,
  attachments,
  setAttachments,
  restoreFileTags,
  getQuotes,
  restoreQuoteTags,
  renderQuoteTags,
}: UseChatInputImperativeHandleOptions): void {
  useImperativeHandle(
    ref,
    () => ({
      getValue: () => {
        invalidateCache();
        return getTextContent();
      },
      setValue: (newValue: string) => {
        if (!editableRef.current) return;
        isExternalUpdateRef.current = true;
        editableRef.current.innerText = newValue;
        if (hasQuoteToken(newValue)) {
          renderQuoteTags?.();
        }
        setHasContent(!!newValue.trim());
        adjustHeight();
        invalidateCache();

        if (newValue) {
          const range = document.createRange();
          const selection = window.getSelection();
          if (!selection) return;

          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      },
      focus: focusInput,
      clear: clearInput,
      hasContent: () => hasContent,
      getFileTags: extractFileTags,
      getAttachments: () => attachments,
      setAttachments,
      restoreFileTags,
      getQuotes: () => getQuotes?.() ?? {},
      restoreQuoteTags: (quotes?: Record<string, { text: string }>) => restoreQuoteTags?.(quotes),
    }),
    [
      getTextContent,
      invalidateCache,
      editableRef,
      isExternalUpdateRef,
      setHasContent,
      adjustHeight,
      focusInput,
      clearInput,
      hasContent,
      extractFileTags,
      attachments,
      setAttachments,
      restoreFileTags,
      getQuotes,
      restoreQuoteTags,
      renderQuoteTags,
    ]
  );
}

