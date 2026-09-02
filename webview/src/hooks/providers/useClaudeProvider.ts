import { useState } from 'react';
import { DEFAULT_CLAUDE_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Claude-specific selectable state. State only — handlers that span providers
 * (mode/model/provider switching, long-context toggle) live in the orchestrator
 * (useModelProviderState) since they need to read both Claude and Codex state.
 */
export function useClaudeProvider() {
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(DEFAULT_CLAUDE_MODEL_ID);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('default');
  const [longContextEnabled, setLongContextEnabled] = useState(true);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);

  return {
    selectedClaudeModel,
    setSelectedClaudeModel,
    claudePermissionMode,
    setClaudePermissionMode,
    longContextEnabled,
    setLongContextEnabled,
    claudeSettingsAlwaysThinkingEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  };
}

export type UseClaudeProviderReturn = ReturnType<typeof useClaudeProvider>;
