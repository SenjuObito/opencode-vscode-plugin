import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
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
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state for OpenCode.
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  const [currentProvider, setCurrentProvider] = useState('opencode');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => (localStorage.getItem('opencode.permissionMode') as PermissionMode) || 'default',
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');

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
    sendBridgeEvent('set_mode', mode);
    localStorage.setItem('opencode.permissionMode', mode);
  }, [setOpenCodePermissionMode]);

  const handleModelSelect = useCallback((modelId: string) => {
    setSelectedOpenCodeModel(modelId);
    sendBridgeEvent('set_model', modelId);
  }, [setSelectedOpenCodeModel]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    setPermissionMode(openCodePermissionMode);
    sendBridgeEvent('set_mode', openCodePermissionMode);
    sendBridgeEvent('set_model', selectedOpenCodeModel);
  }, [openCodePermissionMode, selectedOpenCodeModel]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, [setReasoningEffort]);

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

