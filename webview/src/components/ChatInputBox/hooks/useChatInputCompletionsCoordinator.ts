import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { CommandItem, FileItem, TriggerQuery } from '../types.js';
import { useCompletionDropdown } from './useCompletionDropdown.js';
import { useCompletionTriggerDetection } from './useCompletionTriggerDetection.js';
import { useInlineHistoryCompletion } from './useInlineHistoryCompletion.js';
import {
  commandToDropdownItem,
  dollarCommandProvider,
  dollarCommandToDropdownItem,
  fileReferenceProvider,
  fileToDropdownItem,
  slashCommandProvider,
} from '../providers/index.js';
import { setCursorOffset } from '../utils/selectionUtils.js';

interface UseChatInputCompletionsCoordinatorOptions {
  editableRef: RefObject<HTMLDivElement | null>;
  sharedComposingRef: RefObject<boolean>;
  justRenderedTagRef: RefObject<boolean>;
  getTextContent: () => string;
  pathMappingRef: MutableRefObject<Map<string, string>>;
  setCursorAfterPath: (path: string | null) => void;
  closeAllCompletionsRef: MutableRefObject<() => void>;
  handleInputRef: MutableRefObject<() => void>;
  currentProvider: string;
}

function replaceTextAndSync(
  editableRef: RefObject<HTMLDivElement | null>,
  text: string,
  replacement: string,
  query: TriggerQuery,
  replaceText: (input: string, replacementText: string, currentQuery: TriggerQuery) => string,
  handleInput: () => void
) {
  if (!editableRef.current) return;
  const newText = replaceText(text, replacement, query);
  editableRef.current.innerText = newText;
  const cursorPos = query.start + replacement.length;
  setCursorOffset(editableRef.current, cursorPos);
  handleInput();
}

export function useChatInputCompletionsCoordinator({
  editableRef,
  sharedComposingRef,
  justRenderedTagRef,
  getTextContent,
  pathMappingRef,
  setCursorAfterPath,
  closeAllCompletionsRef,
  handleInputRef,
  currentProvider,
}: UseChatInputCompletionsCoordinatorOptions) {
  const renderFileTagsRef = useRef<() => void>(() => {});

  const fileCompletion = useCompletionDropdown<FileItem>({
    trigger: '@',
    provider: fileReferenceProvider,
    toDropdownItem: fileToDropdownItem,
    onSelect: (file, query) => {
      if (!editableRef.current || !query) return;

      const text = getTextContent();
      const path = file.absolutePath || file.path;
      const replacement = file.type === 'directory' ? `@${path}` : `@${path} `;
      const newText = fileCompletion.replaceText(text, replacement, query);

      if (file.absolutePath) {
        pathMappingRef.current.set(file.name, file.absolutePath);
        pathMappingRef.current.set(file.path, file.absolutePath);
        pathMappingRef.current.set(file.absolutePath, file.absolutePath);
      }

      editableRef.current.innerText = newText;
      const cursorPos = query.start + replacement.length;
      setCursorOffset(editableRef.current, cursorPos);
      handleInputRef.current();
      setCursorAfterPath(path);

      setTimeout(() => {
        renderFileTagsRef.current();
      }, 0);
    },
  });

  const commandCompletion = useCompletionDropdown<CommandItem>({
    trigger: '/',
    provider: slashCommandProvider,
    toDropdownItem: commandToDropdownItem,
    onSelect: (command, query) => {
      if (!editableRef.current || !query) return;
      replaceTextAndSync(
        editableRef,
        getTextContent(),
        `${command.label} `,
        query,
        commandCompletion.replaceText,
        () => handleInputRef.current()
      );
    },
  });

  const dollarCommandCompletion = useCompletionDropdown<CommandItem>({
    trigger: '$',
    provider: dollarCommandProvider,
    toDropdownItem: dollarCommandToDropdownItem,
    onSelect: (skill, query) => {
      if (!editableRef.current || !query) return;
      replaceTextAndSync(
        editableRef,
        getTextContent(),
        `${skill.label} `,
        query,
        dollarCommandCompletion.replaceText,
        () => handleInputRef.current()
      );
    },
  });

  const closeAllCompletions = useCallback(() => {
    fileCompletion.close();
    commandCompletion.close();
    dollarCommandCompletion.close();
  }, [fileCompletion, commandCompletion, dollarCommandCompletion]);

  useEffect(() => {
    closeAllCompletionsRef.current = closeAllCompletions;
  }, [closeAllCompletions, closeAllCompletionsRef]);

  const inlineCompletion = useInlineHistoryCompletion({
    debounceMs: 100,
    minQueryLength: 2,
  });

  const { debouncedDetectCompletion } = useCompletionTriggerDetection({
    editableRef,
    sharedComposingRef,
    justRenderedTagRef,
    getTextContent,
    fileCompletion,
    commandCompletion,
    dollarCommandCompletion,
    isDollarTriggerEnabled: currentProvider === 'codex',
  });

  // Note: completion objects are fresh object literals each render (NOT stable
  // references). Reading .isOpen at call time is still correct because this
  // callback is recreated per render and handleInputRef always holds the latest.
  const syncInlineCompletion = useCallback((text: string) => {
    const isOtherCompletionOpen =
      fileCompletion.isOpen ||
      commandCompletion.isOpen ||
      dollarCommandCompletion.isOpen;

    if (!isOtherCompletionOpen) {
      inlineCompletion.updateQuery(text);
    } else {
      inlineCompletion.clear();
    }
  }, [
    fileCompletion,
    commandCompletion,
    dollarCommandCompletion,
    inlineCompletion,
  ]);

  const setRenderFileTags = useCallback((renderFileTags: () => void) => {
    renderFileTagsRef.current = renderFileTags;
  }, []);

  return {
    fileCompletion,
    commandCompletion,
    dollarCommandCompletion,
    inlineCompletion,
    closeAllCompletions,
    debouncedDetectCompletion,
    syncInlineCompletion,
    setRenderFileTags,
  };
}
