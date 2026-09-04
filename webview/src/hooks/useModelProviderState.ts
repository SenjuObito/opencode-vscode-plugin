import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type {
  CodexFastMode,
  PermissionMode,
  ReasoningEffort,
} from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { isCliOnlyProvider, normalizeCliPermissionMode } from './providers/cliProviders';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the webview bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('opencode');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => (localStorage.getItem('opencode.permissionMode') as PermissionMode) || 'default',
  );

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  // NOTE: useClaudeProvider / useCodexProvider keep their historical names, but
  // the state slots they own (long context, reasoning effort, fast mode and the
  // model id echoed back by the host bridge) are consumed by opencode at
  // runtime — see usageModeCallbacks.ts. Only grok / kimi / pi were removed.
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const openCode = useOpenCodeProvider();
  const { isSdkInstalled, isSdkStatusKnown, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
  } = codex;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedOpenCodeModel,
    setOpenCodePermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedOpenCodeModel,
    openCodePermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  });

  // ── Computed values ──
  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'opencode'
      ? selectedOpenCodeModel
      : selectedClaudeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (currentProvider === 'opencode') {
      // OpenCode 支持原生 plan agent，模式原样透传。
      setPermissionMode(mode);
      setOpenCodePermissionMode(mode);
      sendBridgeEvent('set_mode', mode);
      localStorage.setItem('opencode.permissionMode', mode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      // opencode is the only remaining CLI-only provider.
      const cliMode = normalizeCliPermissionMode(mode);
      setPermissionMode(cliMode);
      setOpenCodePermissionMode(cliMode);
      sendBridgeEvent('set_mode', cliMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setOpenCodePermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [
    currentProvider,
    longContextEnabled,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedOpenCodeModel,
  ]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    let modeToSet: PermissionMode = claudePermissionMode;
    if (providerId === 'codex') {
      modeToSet = normalizeCliPermissionMode(codexPermissionMode);
    } else if (providerId === 'opencode') {
      // OpenCode 支持原生 plan agent，不做 CLI 的 plan 屏蔽。
      modeToSet = openCodePermissionMode;
    }
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    let newModel = apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    if (providerId === 'codex') newModel = selectedCodexModel;
    else if (providerId === 'opencode') newModel = selectedOpenCodeModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    openCodePermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    selectedOpenCodeModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, [setReasoningEffort]);

  const handleCodexFastModeChange = useCallback((mode: CodexFastMode) => {
    setCodexFastMode(mode);
    sendBridgeEvent('set_codex_fast_mode', mode);
  }, [setCodexFastMode]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...openCode,
    ...usage,
    ...settings,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    currentSdkInstalled,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleLongContextChange,
    handleToggleThinking,
    handleReasoningChange,
    handleCodexFastModeChange,
  };
}
