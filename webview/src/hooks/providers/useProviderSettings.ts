import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../../utils/bridge';
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

  const syncActiveProviderModelMapping = useCallback((_provider?: ProviderConfig | null) => {
    // No-op for OpenCode
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
