import { useCallback, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { TFunction as I18nTFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type {
  PermissionMode,
  ReasoningEffort,
} from '../components/ChatInputBox/types';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: I18nTFunction;
  /** Current tab's sessionId, so set_mode is scoped to the right tab session. */
  currentSessionId?: string | null;
  /** Ref to the current tab's sessionId (always fresh). */
  currentSessionIdRef?: MutableRefObject<string | null>;
}

/**
 * Build the `set_model` payload.
 *
 * With a bound session the host receives `{ model, sessionId }` so it writes the
 * selection onto *that* OpencodeSession instead of "the window's current one" —
 * those drift apart as soon as the user switches tabs, and the change lands on
 * the wrong conversation while the UI reports success. Tabs that have not bound
 * a session yet keep the legacy bare-string form.
 */
export function buildModelSelectionPayload(
  modelId: string,
  sessionId: string | null | undefined,
  options?: { silent?: boolean },
): string {
  if (!sessionId) return modelId;
  const payload: Record<string, unknown> = { model: modelId, sessionId };
  if (options?.silent) payload.silent = true;
  return JSON.stringify(payload);
}

/** Same scoping rule as {@link buildModelSelectionPayload}, for reasoning effort. */
export function buildReasoningEffortPayload(
  effort: string,
  sessionId: string | null | undefined,
): string {
  if (!sessionId) return effort;
  return JSON.stringify({ reasoningEffort: effort, sessionId });
}

/**
 * Orchestrates provider/model/permission state for OpenCode.
 */
export function useModelProviderState({ addToast, t, currentSessionId, currentSessionIdRef }: UseModelProviderStateOptions) {
  const [currentProvider, setCurrentProvider] = useState('opencode');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => (localStorage.getItem('opencode.permissionMode') as PermissionMode) || 'default',
  );
  // `default` (send no variant) rather than `medium`: most opencode models do not
  // offer `medium` at all, so defaulting to it picked a level that never applied.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('default');

  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  const openCode = useOpenCodeProvider();
  const { isSdkInstalled, isSdkStatusKnown, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;

  useModelStatePersistence({
    setCurrentProvider,
    setSelectedOpenCodeModel,
    setOpenCodePermissionMode,
    setPermissionMode,
    setReasoningEffort,
    currentProvider,
    selectedOpenCodeModel,
    openCodePermissionMode,
    reasoningEffort,
  });

  const selectedModel = selectedOpenCodeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );

  const handleModeSelect = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    setOpenCodePermissionMode(mode);
    const sessionId = currentSessionIdRef?.current ?? currentSessionId ?? null;
    if (sessionId) {
      // Scope the mode change to the current tab's session so multi-tab isolation holds.
      sendBridgeEvent('set_mode', JSON.stringify({ sessionId, mode }));
    } else {
      sendBridgeEvent('set_mode', mode);
    }
    localStorage.setItem('opencode.permissionMode', mode);
  }, [setOpenCodePermissionMode, currentSessionId, currentSessionIdRef]);

  /**
   * `silent` marks a value that a tab switch is restoring, not a user choice.
   *
   * The host treats a model change as "the user picked a new model": it clears
   * the session's context-usage and pushes an empty usage row. Replaying a tab's
   * own model on switch must not do that, or the usage ring zeroes out every
   * time two tabs with different models are alternated.
   */
  const handleModelSelect = useCallback((modelId: string, options?: { silent?: boolean }) => {
    setSelectedOpenCodeModel(modelId);
    const sessionId = currentSessionIdRef?.current ?? currentSessionId ?? null;
    sendBridgeEvent('set_model', buildModelSelectionPayload(modelId, sessionId, options));
  }, [setSelectedOpenCodeModel, currentSessionId, currentSessionIdRef]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    setPermissionMode(openCodePermissionMode);
    const sessionId = currentSessionIdRef?.current ?? currentSessionId ?? null;
    if (sessionId) {
      sendBridgeEvent('set_mode', JSON.stringify({ sessionId, mode: openCodePermissionMode }));
    } else {
      sendBridgeEvent('set_mode', openCodePermissionMode);
    }
    sendBridgeEvent('set_model', selectedOpenCodeModel);
  }, [openCodePermissionMode, selectedOpenCodeModel, currentSessionId, currentSessionIdRef]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    const sessionId = currentSessionIdRef?.current ?? currentSessionId ?? null;
    sendBridgeEvent('set_reasoning_effort', buildReasoningEffortPayload(effort, sessionId));
  }, [setReasoningEffort, currentSessionId, currentSessionIdRef]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [addToast, t]);

  return {
    ...openCode,
    ...usage,
    ...settings,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    reasoningEffort, setReasoningEffort,
    currentSdkInstalled,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleToggleThinking,
    handleReasoningChange,
  };
}

