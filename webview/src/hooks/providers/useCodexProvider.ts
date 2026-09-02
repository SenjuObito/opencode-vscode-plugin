import { useState } from 'react';
import type {
  CodexFastMode,
  PermissionMode,
  ReasoningEffort,
} from '../../components/ChatInputBox/types';

/**
 * Stub for legacy Codex provider (removed in opencode-only fork).
 * Returns minimal default state so downstream code compiles.
 *
 * Note: the union types are annotated explicitly (rather than inferred as
 * `string`) because the consumers — useModelStatePersistence, App and
 * ChatScreen — expect the narrowed PermissionMode / ReasoningEffort /
 * CodexFastMode unions.
 */
export function useCodexProvider() {
  const [selectedCodexModel, setSelectedCodexModel] = useState('codex-default');
  const [codexPermissionMode, setCodexPermissionMode] = useState<PermissionMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [codexFastMode, setCodexFastMode] = useState<CodexFastMode>('normal');

  return {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
  };
}
