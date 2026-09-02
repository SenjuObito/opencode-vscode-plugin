import { useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import type { PermissionMode } from '../types';

interface CompletionWithKeyDown {
  isOpen: boolean;
  handleKeyDown: (ev: KeyboardEvent) => boolean;
}

interface InlineCompletionHandler {
  applySuggestion: () => boolean;
}

export interface UseKeyboardHandlerOptions {
  isComposingRef: MutableRefObject<boolean>;
  lastCompositionEndTimeRef: MutableRefObject<number>;
  sendShortcut: 'enter' | 'cmdEnter';
  daemonStatusLoaded: boolean;
  sdkInstalled: boolean;
  fileCompletion: CompletionWithKeyDown;
  commandCompletion: CompletionWithKeyDown;
  dollarCommandCompletion: CompletionWithKeyDown;
  handleMacCursorMovement: (e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  handleHistoryKeyDown: (e: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => boolean;
  /** Inline history completion (Tab to apply) */
  inlineCompletion?: InlineCompletionHandler;
  completionSelectedRef: MutableRefObject<boolean>;
  submittedOnEnterRef: MutableRefObject<boolean>;
  handleSubmit: () => void;
  /** Shift+Tab toggles between default (Build) and plan modes */
  onModeSelect?: (mode: PermissionMode) => void;
  permissionMode?: PermissionMode;
}

/**
 * useKeyboardHandler - React keyboard event handling for the chat input box
 *
 * Handles:
 * - Completion dropdown navigation
 * - History navigation (when input empty)
 * - Send shortcut (Enter / Cmd+Enter)
 * - Preventing IME "confirm enter" false send
 */
export function useKeyboardHandler({
  isComposingRef,
  lastCompositionEndTimeRef,
  sendShortcut,
  daemonStatusLoaded,
  sdkInstalled,
  fileCompletion,
  commandCompletion,
  dollarCommandCompletion,
  handleMacCursorMovement,
  handleHistoryKeyDown,
  inlineCompletion,
  completionSelectedRef,
  submittedOnEnterRef,
  handleSubmit,
  onModeSelect,
  permissionMode,
}: UseKeyboardHandlerOptions) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Handle Shift+Tab for mode switching
      if (e.key === 'Tab' && e.shiftKey) {
        if (onModeSelect) {
          e.preventDefault();
          onModeSelect(permissionMode === 'plan' ? 'default' : 'plan');
        }
        return;
      }

      // Handle completion dropdown navigation
      if (fileCompletion.isOpen && fileCompletion.handleKeyDown(e.nativeEvent)) return;
      if (commandCompletion.isOpen && commandCompletion.handleKeyDown(e.nativeEvent)) return;
      if (dollarCommandCompletion.isOpen && dollarCommandCompletion.handleKeyDown(e.nativeEvent)) return;

      // Handle inline completion (Tab to apply)
      if (e.key === 'Tab' && inlineCompletion?.applySuggestion()) {
        e.preventDefault();
        return;
      }

      // Handle history navigation and cursor movement
      if (handleMacCursorMovement(e)) return;
      if (handleHistoryKeyDown(e)) return;

      // Determine if this is a send key
      const isIMEComposing = isComposingRef.current;
      const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;
      const isEnterKey = e.key === 'Enter' || e.nativeEvent.keyCode === 13;
      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey)
          : isEnterKey && !e.shiftKey && !isIMEComposing && !isRecentlyComposing;

      if (!isSendKey) return;

      e.preventDefault();
      if (!daemonStatusLoaded || !sdkInstalled) return;

      submittedOnEnterRef.current = true;
      handleSubmit();
    },
    [
      isComposingRef,
      handleMacCursorMovement,
      fileCompletion,
      commandCompletion,
      dollarCommandCompletion,
      handleHistoryKeyDown,
      inlineCompletion,
      lastCompositionEndTimeRef,
      sendShortcut,
      daemonStatusLoaded,
      sdkInstalled,
      submittedOnEnterRef,
      completionSelectedRef,
      handleSubmit,
      onModeSelect,
      permissionMode,
    ]
  );

  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const isEnterKey =
        e.key === 'Enter' || e.nativeEvent.keyCode === 13;

      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey)
          : isEnterKey && !e.shiftKey;

      if (!isSendKey) return;
      e.preventDefault();

      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
      }
    },
    [sendShortcut, completionSelectedRef, submittedOnEnterRef]
  );

  return { onKeyDown, onKeyUp };
}
