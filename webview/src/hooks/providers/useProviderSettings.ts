import { useCallback, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ProviderConfig } from '../../types/provider';

/**
 * Cross-cutting provider settings: send shortcut, auto-open file,
 * and the active provider config. Each setting handler pushes the change to
 * the backend via bridge event.
 */
export function useProviderSettings() {
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
  }, []);

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
