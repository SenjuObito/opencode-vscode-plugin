import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../../utils/bridge';
import { writeClaudeModelMapping } from '../../utils/claudeModelMapping';
import type { ProviderConfig } from '../../types/provider';

export interface UseProviderSettingsOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Cross-cutting provider settings: send shortcut, auto-open file,
 * and the active provider config. Each setting handler pushes the change to
 * the backend via bridge event and (where applicable) toasts the user-visible
 * state change.
 */
export function useProviderSettings({ addToast, t }: UseProviderSettingsOptions) {
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const [autoOpenFileEnabled, setAutoOpenFileEnabled] = useState(false);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [, setProviderConfigVersion] = useState(0);

  const syncActiveProviderModelMapping = useCallback((provider?: ProviderConfig | null) => {
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      writeClaudeModelMapping({});
      return;
    }
    const env = provider.settingsConfig.env as Record<string, unknown>;
    const get = (key: string): string => (typeof env[key] === 'string' ? (env[key] as string) : '');
    const mapping = {
      main: get('ANTHROPIC_MODEL'),
      fable: get('ANTHROPIC_DEFAULT_FABLE_MODEL'),
      haiku: get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
      sonnet: get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
      opus: get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    };
    writeClaudeModelMapping(mapping);
  }, []);


  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    setSendShortcut(shortcut);
    sendBridgeEvent('set_send_shortcut', JSON.stringify({ sendShortcut: shortcut }));
  }, []);

  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    setAutoOpenFileEnabled(enabled);
    sendBridgeEvent('set_auto_open_file_enabled', JSON.stringify({ autoOpenFileEnabled: enabled }));
    addToast(
      enabled ? t('settings.basic.autoOpenFile.enabled') : t('settings.basic.autoOpenFile.disabled'),
      'success',
    );
  }, [t, addToast]);

  return {
    sendShortcut,
    setSendShortcut,
    autoOpenFileEnabled,
    setAutoOpenFileEnabled,
    activeProviderConfig,
    setActiveProviderConfig,
    setProviderConfigVersion,
    syncActiveProviderModelMapping,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
  };
}

export type UseProviderSettingsReturn = ReturnType<typeof useProviderSettings>;
