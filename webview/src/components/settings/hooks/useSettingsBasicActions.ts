// hooks/useSettingsBasicActions.ts
import { useState, useEffect, useCallback } from 'react';
export type { UiFontConfig, CodeFontConfig } from '../../../types/uiFontConfig';
import type { UiFontConfig, CodeFontConfig } from '../../../types/uiFontConfig';
import {
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  clampPermissionDialogTimeoutSeconds,
} from '../../../utils/permissionDialogTimeout';
import {
  SKIP_NEW_SESSION_CONFIRM_EVENT,
  type SkipNewSessionConfirmChangedDetail,
} from '../../../utils/skipNewSessionConfirm';
import {
  DETAILED_OUTPUT_ENABLED_EVENT,
  setDetailedOutputEnabled,
  type DetailedOutputEnabledChangedDetail,
} from '../../../utils/detailedOutputPreference';
import {
  getUiPreferences,
  updateUiPreferences,
  UI_PREFERENCES_CHANGED_EVENT,
  type UiPreferences,
  type UiPreferencesChangedDetail,
} from '../../../utils/uiPreferences';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

export interface UseSettingsBasicActionsProps {
  sendShortcutProp?: 'enter' | 'cmdEnter';
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
  autoOpenFileEnabledProp?: boolean;
  onAutoOpenFileEnabledChangeProp?: (enabled: boolean) => void;
  permissionDialogTimeoutSecondsProp?: number;
  onPermissionDialogTimeoutChangeProp?: (seconds: number) => void;
  /** Current chat CLI — prompt enhancer auto mode follows this when available. */
  currentProvider?: string;
}

export interface UseSettingsBasicActionsReturn {
  // =========================================================================
  // Public read-only state (safe to read in components)
  // =========================================================================
  claudeCliPath: string;
  savingClaudeCliPath: boolean;
  workingDirectory: string;
  savingWorkingDirectory: boolean;
  editorFontConfig:
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined;
  /** Named fonts parsed from the VS Code `editor.fontFamily` setting. */
  vscodeFontList: string[];
  /** All installed font families, enumerated host-side (OS font directories). */
  systemFontList: string[];
  /** Non-empty when host-side font enumeration failed. */
  systemFontError: string | null;
  uiFontConfig: UiFontConfig | undefined;
  codeFontConfig: CodeFontConfig | undefined;
  /** Send shortcut state (prefers prop over local state) */
  sendShortcut: 'enter' | 'cmdEnter';
  localSendShortcut: 'enter' | 'cmdEnter';
  /** Auto open file state (prefers prop over local state) */
  autoOpenFileEnabled: boolean;
  localAutoOpenFileEnabled: boolean;
  soundNotificationEnabled: boolean;
  soundOnlyWhenUnfocused: boolean;
  selectedSound: string;
  customSoundPath: string;
  diffExpandedByDefault: boolean;
  historyCompletionEnabled: boolean;
  /** Whether to skip the "create new session with existing messages" confirm dialog. */
  skipNewSessionConfirm: boolean;
  taskCompletionNotificationEnabled: boolean;
  askUserQuestionNotificationEnabled: boolean;
  detailedOutputEnabled: boolean;
  systemNotificationOnlyWhenUnfocused: boolean;
  askUserQuestionSoundNotificationEnabled: boolean;

  // =========================================================================
  // Handler functions (public API for components)
  // =========================================================================
  handleSaveClaudeCliPath: () => void;
  handleSaveWorkingDirectory: () => void;
  handleUiFontSelectionChange: (selection: string) => void;
  handleSaveUiFontCustomPath: (path: string) => void;
  handleBrowseUiFontFile: () => void;
  handleCodeFontSelectionChange: (selection: string) => void;
  handleSaveCodeFontCustomPath: (path: string) => void;
  handleBrowseCodeFontFile: () => void;
  handleSendShortcutChange: (shortcut: 'enter' | 'cmdEnter') => void;
  handleAutoOpenFileEnabledChange: (enabled: boolean) => void;
  handleSoundNotificationEnabledChange: (enabled: boolean) => void;
  handleSoundOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  handleSelectedSoundChange: (soundId: string) => void;
  handleCustomSoundPathChange: (path: string) => void;
  handleSaveCustomSoundPath: () => void;
  handleTestSound: () => void;
  handleBrowseSound: () => void;
  handleTaskCompletionNotificationEnabledChange: (enabled: boolean) => void;
  handleAskUserQuestionNotificationEnabledChange: (enabled: boolean) => void;
  handleDetailedOutputEnabledChange: (enabled: boolean) => void;
  handleSystemNotificationOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  handleAskUserQuestionSoundNotificationEnabledChange: (enabled: boolean) => void;
  permissionDialogTimeoutSeconds: number;
  handlePermissionDialogTimeoutChange: (seconds: number) => void;

  // =========================================================================
  // @internal — State setters used only by useSettingsWindowCallbacks.
  // Components should not call these directly; use handlers above instead.
  // =========================================================================
  /** @internal */ setClaudeCliPath: (path: string) => void;
  /** @internal */ setSavingClaudeCliPath: (saving: boolean) => void;
  /** @internal */ setWorkingDirectory: (dir: string) => void;
  /** @internal */ setSavingWorkingDirectory: (saving: boolean) => void;
  /** @internal */ setEditorFontConfig: (
    config:
      | {
          fontFamily: string;
          fontSize: number;
          lineSpacing: number;
      }
      | undefined
  ) => void;
  /** @internal */ setVscodeFontList: (fonts: string[]) => void;
  /** @internal */ setSystemFontList: (fonts: string[]) => void;
  /** @internal */ setSystemFontError: (error: string | null) => void;
  /** @internal */ setUiFontConfig: (config: UiFontConfig | undefined) => void;
  /** @internal */ setCodeFontConfig: (config: CodeFontConfig | undefined) => void;
  /** @internal */ setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  /** @internal */ setLocalAutoOpenFileEnabled: (enabled: boolean) => void;
  /** @internal */ setSoundNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setSoundOnlyWhenUnfocused: (enabled: boolean) => void;
  /** @internal */ setSelectedSound: (soundId: string) => void;
  /** @internal */ setCustomSoundPath: (path: string) => void;
  /** @internal */ setDiffExpandedByDefault: (expanded: boolean) => void;
  /** @internal */ setHistoryCompletionEnabled: (enabled: boolean) => void;
  /** @internal */ setSkipNewSessionConfirm: (enabled: boolean) => void;
  /** @internal */ setTaskCompletionNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setAskUserQuestionNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setSystemNotificationOnlyWhenUnfocused: (enabled: boolean) => void;
  /** @internal */ setAskUserQuestionSoundNotificationEnabled: (enabled: boolean) => void;
}

export function useSettingsBasicActions({
  sendShortcutProp,
  onSendShortcutChangeProp,
  autoOpenFileEnabledProp,
  onAutoOpenFileEnabledChangeProp,
  permissionDialogTimeoutSecondsProp,
  onPermissionDialogTimeoutChangeProp,
  currentProvider: _currentProvider,
}: UseSettingsBasicActionsProps): UseSettingsBasicActionsReturn {
  // Custom Claude CLI path (overrides bundled SDK when set)
  const [claudeCliPath, setClaudeCliPath] = useState('');
  const [savingClaudeCliPath, setSavingClaudeCliPath] = useState(false);

  // Working directory configuration
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [savingWorkingDirectory, setSavingWorkingDirectory] = useState(false);

  // IDEA editor font configuration (read-only display)
  const [editorFontConfig, setEditorFontConfig] = useState<
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined
  >();
  const [vscodeFontList, setVscodeFontList] = useState<string[]>([]);
  const [systemFontList, setSystemFontList] = useState<string[]>([]);
  const [systemFontError, setSystemFontError] = useState<string | null>(null);
  const [uiFontConfig, setUiFontConfig] = useState<UiFontConfig | undefined>();
  const [codeFontConfig, setCodeFontConfig] = useState<CodeFontConfig | undefined>();

  // Send shortcut configuration - prefer props, fallback to local state
  const [localSendShortcut, setLocalSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const sendShortcut = sendShortcutProp ?? localSendShortcut;

  // Auto open file configuration - prefer props, fallback to local state
  const [localAutoOpenFileEnabled, setLocalAutoOpenFileEnabled] = useState<boolean>(false);
  const autoOpenFileEnabled = autoOpenFileEnabledProp ?? localAutoOpenFileEnabled;

  // Sound notification configuration
  const [soundNotificationEnabled, setSoundNotificationEnabled] = useState<boolean>(false);
  const [soundOnlyWhenUnfocused, setSoundOnlyWhenUnfocused] = useState<boolean>(false);
  const [selectedSound, setSelectedSound] = useState<string>('default');
  const [customSoundPath, setCustomSoundPath] = useState<string>('');

  // Diff expanded by default — 宿主 globalState 持久化（localStorage 仅作镜像）
  const [diffExpandedByDefault, setDiffExpandedByDefault] = useState<boolean>(
    () => getUiPreferences().diffExpandedByDefault,
  );

  // History completion toggle configuration
  const [historyCompletionEnabled, setHistoryCompletionEnabled] = useState<boolean>(
    () => getUiPreferences().historyCompletionEnabled,
  );

  // "Skip new-session confirm dialog" preference (localStorage-only, default: false).
  // Synced bidirectionally with the dialog checkbox via CustomEvent so toggling
  // either surface (dialog or settings page) updates the other immediately.
  const [skipNewSessionConfirm, setSkipNewSessionConfirm] = useState<boolean>(
    () => getUiPreferences().skipNewSessionConfirm,
  );
  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<SkipNewSessionConfirmChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setSkipNewSessionConfirm(custom.detail.enabled);
      }
    };
    window.addEventListener(SKIP_NEW_SESSION_CONFIRM_EVENT, handler);
    return () => window.removeEventListener(SKIP_NEW_SESSION_CONFIRM_EVENT, handler);
  }, []);

  // Task completion notification toggle (default: false, opt-in feature)
  const [taskCompletionNotificationEnabled, setTaskCompletionNotificationEnabled] = useState<boolean>(false);

  // AskUserQuestion reminder notification toggle (default: false, opt-in feature)
  const [askUserQuestionNotificationEnabled, setAskUserQuestionNotificationEnabled] = useState<boolean>(false);
  const [systemNotificationOnlyWhenUnfocused, setSystemNotificationOnlyWhenUnfocused] = useState<boolean>(false);
  const [askUserQuestionSoundNotificationEnabled, setAskUserQuestionSoundNotificationEnabled] = useState<boolean>(false);

  // Detailed message footer output (default: false to preserve original footer style)
  const [detailedOutputEnabled, setDetailedOutputEnabledState] = useState<boolean>(
    () => getUiPreferences().detailedOutputEnabled,
  );

  // 宿主推送权威偏好时同步本地状态（只认 source==='host'）。
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<UiPreferencesChangedDetail>).detail;
      if (detail?.source !== 'host' || !detail.preferences) return;
      const next: UiPreferences = detail.preferences;
      setDiffExpandedByDefault(next.diffExpandedByDefault);
      setHistoryCompletionEnabled(next.historyCompletionEnabled);
      setSkipNewSessionConfirm(next.skipNewSessionConfirm);
      setDetailedOutputEnabledState(next.detailedOutputEnabled);
    };
    window.addEventListener(UI_PREFERENCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(UI_PREFERENCES_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<DetailedOutputEnabledChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setDetailedOutputEnabledState(custom.detail.enabled);
      }
    };
    window.addEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
    return () => window.removeEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
  }, []);

  // Permission dialog timeout — owned by App.tsx; we treat the prop as authoritative.
  // We intentionally do NOT keep a local copy: it would be dead state because the
  // prop is always provided in production, and a divergent local copy could be read
  // by accident in future refactors.
  const permissionDialogTimeoutSeconds =
    permissionDialogTimeoutSecondsProp ?? DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;

  // Diff expanded by default handler
  useEffect(() => {
    updateUiPreferences({ diffExpandedByDefault });
  }, [diffExpandedByDefault]);

  // 历史补全开关：写共享偏好仓库 + 广播，供输入框等其它界面同步
  useEffect(() => {
    updateUiPreferences({ historyCompletionEnabled });
  }, [historyCompletionEnabled]);

  // 新建会话确认对话框开关
  useEffect(() => {
    updateUiPreferences({ skipNewSessionConfirm });
  }, [skipNewSessionConfirm]);

  const handleSaveClaudeCliPath = useCallback(() => {
    setSavingClaudeCliPath(true);
    const payload = { path: (claudeCliPath || '').trim() };
    sendToJava(`set_claude_cli_path:${JSON.stringify(payload)}`);
  }, [claudeCliPath]);

  const handleSaveWorkingDirectory = useCallback(() => {
    setSavingWorkingDirectory(true);
    const payload = { customWorkingDir: (workingDirectory || '').trim() };
    sendToJava(`set_working_directory:${JSON.stringify(payload)}`);
  }, [workingDirectory]);

  const handleUiFontSelectionChange = useCallback((selection: string) => {
    if (selection.startsWith('named:')) {
      const fontFamily = selection.slice('named:'.length);
      if (fontFamily) {
        sendToJava(`set_ui_font_config:${JSON.stringify({ mode: 'named', fontFamily })}`);
      }
      return;
    }

    if (selection === 'followEditor') {
      sendToJava(`set_ui_font_config:${JSON.stringify({ mode: 'followEditor' })}`);
      return;
    }

    if (selection === 'customFile' && uiFontConfig?.customFontPath) {
      sendToJava(`set_ui_font_config:${JSON.stringify({
        mode: 'customFile',
        customFontPath: uiFontConfig.customFontPath,
      })}`);
    }
  }, [uiFontConfig?.customFontPath]);

  const handleSaveUiFontCustomPath = useCallback((path: string) => {
    sendToJava(`set_ui_font_config:${JSON.stringify({
      mode: 'customFile',
      customFontPath: path,
    })}`);
  }, []);

  const handleBrowseUiFontFile = useCallback(() => {
    sendToJava('browse_ui_font_file:');
  }, []);

  const handleCodeFontSelectionChange = useCallback((selection: string) => {
    if (selection.startsWith('named:')) {
      const fontFamily = selection.slice('named:'.length);
      if (fontFamily) {
        sendToJava(`set_code_font_config:${JSON.stringify({ mode: 'named', fontFamily })}`);
      }
      return;
    }

    if (selection === 'followEditor') {
      sendToJava(`set_code_font_config:${JSON.stringify({ mode: 'followEditor' })}`);
      return;
    }

    if (selection === 'customFile' && codeFontConfig?.customFontPath) {
      sendToJava(`set_code_font_config:${JSON.stringify({
        mode: 'customFile',
        customFontPath: codeFontConfig.customFontPath,
      })}`);
    }
  }, [codeFontConfig?.customFontPath]);

  const handleSaveCodeFontCustomPath = useCallback((path: string) => {
    sendToJava(`set_code_font_config:${JSON.stringify({
      mode: 'customFile',
      customFontPath: path,
    })}`);
  }, []);

  const handleBrowseCodeFontFile = useCallback(() => {
    sendToJava('browse_code_font_file:');
  }, []);

  // Send shortcut change handler
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onSendShortcutChangeProp) {
      onSendShortcutChangeProp(shortcut);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalSendShortcut(shortcut);
      const payload = { sendShortcut: shortcut };
      sendToJava(`set_send_shortcut:${JSON.stringify(payload)}`);
    }
  }, [onSendShortcutChangeProp]);

  // Auto open file toggle change handler
  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onAutoOpenFileEnabledChangeProp) {
      onAutoOpenFileEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalAutoOpenFileEnabled(enabled);
      const payload = { autoOpenFileEnabled: enabled };
      sendToJava(`set_auto_open_file_enabled:${JSON.stringify(payload)}`);
    }
  }, [onAutoOpenFileEnabledChangeProp]);

  // Sound notification toggle change handler
  const handleSoundNotificationEnabledChange = useCallback((enabled: boolean) => {
    setSoundNotificationEnabled(enabled);
    const payload = { enabled };
    sendToJava(`set_sound_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Sound only-when-unfocused toggle change handler
  const handleSoundOnlyWhenUnfocusedChange = useCallback((enabled: boolean) => {
    setSoundOnlyWhenUnfocused(enabled);
    const payload = { onlyWhenUnfocused: enabled };
    sendToJava(`set_sound_only_when_unfocused:${JSON.stringify(payload)}`);
  }, []);

  // Selected sound change handler
  const handleSelectedSoundChange = useCallback((soundId: string) => {
    setSelectedSound(soundId);
    const payload = { soundId };
    sendToJava(`set_selected_sound:${JSON.stringify(payload)}`);
  }, []);

  // Custom sound path change handler
  const handleCustomSoundPathChange = useCallback((path: string) => {
    setCustomSoundPath(path);
  }, []);

  // Save custom sound path
  const handleSaveCustomSoundPath = useCallback(() => {
    const payload = { path: customSoundPath };
    sendToJava(`set_custom_sound_path:${JSON.stringify(payload)}`);
  }, [customSoundPath]);

  // Test sound — synthesize via Web Audio API (host-side playback is not
  // available in VS Code; built-in sounds are generated tones).
  const handleTestSound = useCallback(() => {
    type AudioContextCtor = typeof AudioContext;
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const now = ctx.currentTime;
      const tone = (freq: number, start: number, duration: number, gainValue = 0.18, type: OscillatorType = 'sine') => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(gainValue, now + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + duration);
      };
      switch (selectedSound) {
        case 'chime':
          tone(523.25, 0, 0.25);
          tone(659.25, 0.12, 0.25);
          tone(783.99, 0.24, 0.35);
          break;
        case 'bell':
          tone(880, 0, 0.3, 0.14);
          tone(1320, 0, 0.3, 0.08);
          break;
        case 'ding':
          tone(1200, 0, 0.15, 0.2);
          break;
        case 'success':
          tone(523.25, 0, 0.12);
          tone(659.25, 0.1, 0.12);
          tone(783.99, 0.2, 0.12);
          tone(1046.5, 0.3, 0.3);
          break;
        case 'default':
        default:
          tone(800, 0, 0.2);
          break;
      }
      window.setTimeout(() => void ctx.close().catch(() => {}), 1200);
    } catch {
      // Audio unavailable — ignore
    }
  }, [selectedSound]);

  // Browse sound file
  const handleBrowseSound = useCallback(() => {
    sendToJava('browse_sound_file:');
  }, []);

  // Task completion notification toggle change handler
  const handleTaskCompletionNotificationEnabledChange = useCallback((enabled: boolean) => {
    setTaskCompletionNotificationEnabled(enabled);
    const payload = { taskCompletionNotificationEnabled: enabled };
    sendToJava(`set_task_completion_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // AskUserQuestion reminder notification toggle change handler
  const handleAskUserQuestionNotificationEnabledChange = useCallback((enabled: boolean) => {
    setAskUserQuestionNotificationEnabled(enabled);
    const payload = { askUserQuestionNotificationEnabled: enabled };
    sendToJava(`set_ask_user_question_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  const handleDetailedOutputEnabledChange = useCallback((enabled: boolean) => {
    setDetailedOutputEnabledState(enabled);
    // 先写 localStorage 并广播（其它界面订阅 DETAILED_OUTPUT_ENABLED_EVENT），
    // 再同步到宿主 globalState。
    setDetailedOutputEnabled(enabled);
    updateUiPreferences({ detailedOutputEnabled: enabled });
  }, []);

  const handleSystemNotificationOnlyWhenUnfocusedChange = useCallback((enabled: boolean) => {
    setSystemNotificationOnlyWhenUnfocused(enabled);
    const payload = { systemNotificationOnlyWhenUnfocused: enabled };
    sendToJava(`set_system_notification_only_when_unfocused:${JSON.stringify(payload)}`);
  }, []);

  const handleAskUserQuestionSoundNotificationEnabledChange = useCallback((enabled: boolean) => {
    setAskUserQuestionSoundNotificationEnabled(enabled);
    const payload = { askUserQuestionSoundNotificationEnabled: enabled };
    sendToJava(`set_ask_user_question_sound_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Permission dialog timeout change handler
  const handlePermissionDialogTimeoutChange = useCallback((seconds: number) => {
    const clamped = clampPermissionDialogTimeoutSeconds(seconds);
    // App.tsx owns the canonical state and provides the callback in production.
    onPermissionDialogTimeoutChangeProp?.(clamped);
    const payload = { permissionDialogTimeoutSeconds: clamped };
    sendToJava(`set_permission_dialog_timeout:${JSON.stringify(payload)}`);
  }, [onPermissionDialogTimeoutChangeProp]);

  return {
    claudeCliPath,
    setClaudeCliPath,
    savingClaudeCliPath,
    setSavingClaudeCliPath,
    workingDirectory,
    setWorkingDirectory,
    savingWorkingDirectory,
    setSavingWorkingDirectory,
    editorFontConfig,
    setEditorFontConfig,
    vscodeFontList,
    setVscodeFontList,
    systemFontList,
    setSystemFontList,
    systemFontError,
    setSystemFontError,
    uiFontConfig,
    setUiFontConfig,
    codeFontConfig,
    setCodeFontConfig,
    localSendShortcut,
    setLocalSendShortcut,
    sendShortcut,
    localAutoOpenFileEnabled,
    setLocalAutoOpenFileEnabled,
    autoOpenFileEnabled,
    soundNotificationEnabled,
    setSoundNotificationEnabled,
    soundOnlyWhenUnfocused,
    setSoundOnlyWhenUnfocused,
    selectedSound,
    setSelectedSound,
    customSoundPath,
    setCustomSoundPath,
    diffExpandedByDefault,
    setDiffExpandedByDefault,
    historyCompletionEnabled,
    setHistoryCompletionEnabled,
    skipNewSessionConfirm,
    setSkipNewSessionConfirm,
    handleSaveClaudeCliPath,
    handleSaveWorkingDirectory,
    handleUiFontSelectionChange,
    handleSaveUiFontCustomPath,
    handleBrowseUiFontFile,
    handleCodeFontSelectionChange,
    handleSaveCodeFontCustomPath,
    handleBrowseCodeFontFile,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
    handleSoundNotificationEnabledChange,
    handleSoundOnlyWhenUnfocusedChange,
    handleSelectedSoundChange,
    handleCustomSoundPathChange,
    handleSaveCustomSoundPath,
    handleTestSound,
    handleBrowseSound,
    taskCompletionNotificationEnabled,
    setTaskCompletionNotificationEnabled,
    handleTaskCompletionNotificationEnabledChange,
    askUserQuestionNotificationEnabled,
    setAskUserQuestionNotificationEnabled,
    handleAskUserQuestionNotificationEnabledChange,
    detailedOutputEnabled,
    handleDetailedOutputEnabledChange,
    systemNotificationOnlyWhenUnfocused,
    setSystemNotificationOnlyWhenUnfocused,
    handleSystemNotificationOnlyWhenUnfocusedChange,
    askUserQuestionSoundNotificationEnabled,
    setAskUserQuestionSoundNotificationEnabled,
    handleAskUserQuestionSoundNotificationEnabledChange,
    permissionDialogTimeoutSeconds,
    handlePermissionDialogTimeoutChange,
  };
}
