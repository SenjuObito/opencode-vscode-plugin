import { useCallback, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent, sendHostCommand } from '../utils/bridge';
import { getTabStore } from '../store/tabStore';
import {
  OPENCODE_DEFAULT_MODEL_ID,
  type PermissionMode,
  type ReasoningEffort,
} from '../components/ChatInputBox/types';
import { useCliModels } from './providers/useCliModels';
import { resolveProviderModels } from '../components/ChatInputBox/resolveProviderModels';
import { getFirstPreferredModelId } from '../components/ChatInputBox/modelSelectUtils';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
  /** Current tab's sessionId, so the change is scoped to the right tab session. */
  currentSessionId?: string | null;
  /** Ref to the current tab's sessionId (always fresh). */
  currentSessionIdRef?: MutableRefObject<string | null>;
}

/**
 * Build the payload for a model selection.
 *
 * <p>The session the change is scoped to travels in the command envelope, not in
 * the payload: one identity, one place. The host merges the envelope's session
 * into the payload before the handler sees it, so a payload that repeated it
 * could only ever disagree with the envelope.</p>
 */
export function buildModelSelectionPayload(
  modelId: string,
  options?: { silent?: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: modelId };
  if (options?.silent) payload.silent = true;
  return payload;
}

/** Same rule as {@link buildModelSelectionPayload}, for reasoning effort. */
export function buildReasoningEffortPayload(effort: string): Record<string, unknown> {
  return { reasoningEffort: effort };
}

/**
 * Resolve the active tab's bound session.
 *
 * When the host passes a ref it is authoritative: a tab that has just been
 * unbound / created deliberately has `null` there, and `null ?? currentSessionId`
 * would fall back to the *previous* tab's id while React state catches up. That
 * fallback is how a brand-new tab used to rewrite the outgoing session.
 */
function resolveBoundSessionId(
  currentSessionId: string | null | undefined,
  currentSessionIdRef: MutableRefObject<string | null> | undefined,
): string | null {
  if (currentSessionIdRef) return currentSessionIdRef.current;
  return currentSessionId ?? null;
}

/**
 * Orchestrates provider/model/permission state for OpenCode.
 */
export function useModelProviderState({
  addToast,
  t,
  currentSessionId,
  currentSessionIdRef,
}: UseModelProviderStateOptions) {
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

  const sendSettingsToActiveTab = useCallback(
    (type: string, sessionId: string, payload: Record<string, unknown>) => {
      const tabId = getTabStore().getActiveTabId();
      if (!tabId) return;
      sendHostCommand(tabId, type, payload, sessionId);
    },
    [],
  );

  const handleModeSelect = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    setOpenCodePermissionMode(mode);
    localStorage.setItem('opencode.permissionMode', mode);
    const sessionId = resolveBoundSessionId(currentSessionId, currentSessionIdRef);
    // Unbound tab: the mode has no host target yet. It travels with the first
    // session.send payload, so writing it to "the window's current session"
    // would rewrite the previously active tab instead.
    if (!sessionId) return;
    sendSettingsToActiveTab('settings.mode', sessionId, { mode });
  }, [setOpenCodePermissionMode, currentSessionId, currentSessionIdRef, sendSettingsToActiveTab]);

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
    const sessionId = resolveBoundSessionId(currentSessionId, currentSessionIdRef);
    // No session yet: keep it local; the model is sent with the first message.
    if (!sessionId) return;
    sendSettingsToActiveTab('settings.model', sessionId, buildModelSelectionPayload(modelId, options));
  }, [setSelectedOpenCodeModel, currentSessionId, currentSessionIdRef, sendSettingsToActiveTab]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    setPermissionMode(openCodePermissionMode);
    const sessionId = resolveBoundSessionId(currentSessionId, currentSessionIdRef);
    if (!sessionId) return;
    sendSettingsToActiveTab('settings.mode', sessionId, { mode: openCodePermissionMode });
    sendSettingsToActiveTab('settings.model', sessionId, buildModelSelectionPayload(selectedOpenCodeModel));
  }, [openCodePermissionMode, selectedOpenCodeModel, currentSessionId, currentSessionIdRef, sendSettingsToActiveTab]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    const sessionId = resolveBoundSessionId(currentSessionId, currentSessionIdRef);
    if (!sessionId) return;
    sendSettingsToActiveTab('settings.reasoning', sessionId, buildReasoningEffortPayload(effort));
  }, [setReasoningEffort, currentSessionId, currentSessionIdRef, sendSettingsToActiveTab]);

  const { cliModels, cliDefaultModel, cliCatalogHasEntries } = useCliModels(currentProvider);
  const availableModels = useMemo(() => {
    return resolveProviderModels({
      provider: currentProvider,
      cliModels,
      cliCatalogHasEntries,
    });
  }, [currentProvider, cliModels, cliCatalogHasEntries]);

  const resetToPreferredModel = useCallback(() => {
    const preferred = getFirstPreferredModelId(currentProvider, availableModels, cliDefaultModel);
    const targetModel = preferred || OPENCODE_DEFAULT_MODEL_ID;
    if (targetModel) {
      setSelectedOpenCodeModel(targetModel);
      const sessionId = resolveBoundSessionId(currentSessionId, currentSessionIdRef);
      // Unbound tab: keep it local; the model travels with the first message.
      if (!sessionId) return;
      sendSettingsToActiveTab('settings.model', sessionId, buildModelSelectionPayload(targetModel));
    }
  }, [currentProvider, availableModels, cliDefaultModel, setSelectedOpenCodeModel, currentSessionId, currentSessionIdRef, sendSettingsToActiveTab]);

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
    resetToPreferredModel,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
  };
}

