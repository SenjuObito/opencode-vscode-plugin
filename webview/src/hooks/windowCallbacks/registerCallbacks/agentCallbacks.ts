/**
 * agentCallbacks.ts
 *
 * Registers window bridge callbacks for selection context:
 * addSelectionInfo, addCodeSnippet, clearSelectionInfo.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

export function registerAgentAndSelectionCallbacks(options: UseWindowCallbacksOptions): void {
  const {
  setContextInfo,
} = options;

  window.addSelectionInfo = (selectionInfo) => {
    if (selectionInfo) {
      const match = selectionInfo.match(/^@([^#]+)(?:#L(\d+)(?:-(\d+))?)?$/);
      if (match) {
        const file = match[1];
        const startLine = match[2] ? parseInt(match[2], 10) : undefined;
        const endLine =
          match[3] ? parseInt(match[3], 10) : startLine !== undefined ? startLine : undefined;
        setContextInfo({
          file,
          startLine,
          endLine,
          raw: selectionInfo,
        });
      }
    }
  };

  window.addCodeSnippet = (selectionInfo) => {
    if (selectionInfo && window.insertCodeSnippetAtCursor) {
      window.insertCodeSnippetAtCursor(selectionInfo);
    }
  };

  window.clearSelectionInfo = () => {
    setContextInfo(null);
  };

}
