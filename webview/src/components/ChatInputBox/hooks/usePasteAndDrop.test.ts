import { act, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { usePasteAndDrop } from './usePasteAndDrop.js';

function createEditable(): HTMLDivElement {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  document.body.appendChild(editable);
  return editable;
}

function placeCaretAtEnd(editable: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createPasteEvent(text: string): React.ClipboardEvent {
  return {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain' }],
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

function setupPasteHook(editable: HTMLDivElement) {
  const pathMappingRef = { current: new Map<string, string>() };
  const renderFileTags = vi.fn();
  const hook = renderHook(() => usePasteAndDrop({
    editableRef: { current: editable },
    pathMappingRef,
    getTextContent: () => editable.textContent ?? '',
    adjustHeight: vi.fn(),
    renderFileTags,
    setHasContent: vi.fn(),
    setInternalAttachments: vi.fn() as unknown as React.Dispatch<React.SetStateAction<Attachment[]>>,
    onInput: vi.fn(),
    closeAllCompletions: vi.fn(),
    handleInput: vi.fn(),
    flushInput: vi.fn(),
  }));

  return { ...hook, pathMappingRef, renderFileTags };
}

describe('usePasteAndDrop file references', () => {
  beforeEach(() => {
    // happy-dom does not implement the deprecated command used by the
    // production helper; returning false exercises its Range fallback.
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(document, 'execCommand');
    delete window.getClipboardFilePath;
  });


  it('keeps mixed ordinary text unchanged and does not register its @ text', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = 'const email = "user@example.com"; @/workspace/src/index.vue';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });

  it('keeps trailing prose after an absolute-looking reference unchanged', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = '@C:\\workspace\\view.xml please review';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });


});
