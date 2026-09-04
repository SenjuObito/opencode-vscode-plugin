// hooks/useSettingsWindowCallbacks.ts
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '../../../types/agent';

import type { UiFontConfig, CodeFontConfig } from './useSettingsBasicActions';
import type { AlertType } from '../../AlertDialog';
import type { ToastMessage } from '../../Toast';
import { scheduleBatchedBridgeRequests } from './scheduleBatchedBridgeRequests';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

/**
 * Settings bootstrap bridge messages, ordered by first-paint priority.
 * Batched on open so CEF/Java is not hit with ~20 messages in one frame.
 */
export const SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES = [
  // Environment + permissions (visible / used early on basic tab)
  'get_claude_cli_path:',
  'get_working_directory:',
  'get_streaming_enabled:',
  'get_permission_dialog_timeout:',
  // Appearance fonts
  'get_editor_font_config:',
  'get_vscode_font_list:',
  'get_system_font_list:',
  'get_ui_font_config:',
  'get_code_font_config:',
  // Behavior / feature toggles (basic tab sub-views)
  'get_sound_notification_config:',
  'get_task_completion_notification_enabled:',
  'get_ask_user_question_notification_enabled:',
  'get_system_notification_only_when_unfocused:',
  'get_ask_user_question_sound_notification_enabled:',
  // NOTE: commit prompt / commit AI / prompt-enhancer configs are intentionally
  // NOT bootstrapped here. Their handlers probe CLI availability (spawn processes)
  // on the JCEF UI thread and freeze Settings until complete. Load on tab open.
] as const;

export interface SettingsWindowCallbacksDeps {
  // State setters
  setClaudeCliPath: (path: string) => void;
  setSavingClaudeCliPath: (saving: boolean) => void;
  setWorkingDirectory: (dir: string) => void;
  setSavingWorkingDirectory: (saving: boolean) => void;

  setEditorFontConfig: (config: { fontFamily: string; fontSize: number; lineSpacing: number } | undefined) => void;
   setUiFontConfig: (config: UiFontConfig | undefined) => void;
   setCodeFontConfig: (config: CodeFontConfig | undefined) => void;
   setVscodeFontList?: (fonts: string[]) => void;
   setSystemFontList?: (fonts: string[]) => void;
   setSystemFontError?: (error: string | null) => void;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  // AI feature toggle setters
  setTaskCompletionNotificationEnabled?: (enabled: boolean) => void;
  setAskUserQuestionNotificationEnabled?: (enabled: boolean) => void;
  setSystemNotificationOnlyWhenUnfocused?: (enabled: boolean) => void;
  setAskUserQuestionSoundNotificationEnabled?: (enabled: boolean) => void;
  // Sound notification setters
  setSoundNotificationEnabled?: (enabled: boolean) => void;
  setSoundOnlyWhenUnfocused?: (enabled: boolean) => void;
  setSelectedSound?: (soundId: string) => void;
  setCustomSoundPath?: (path: string) => void;

  // Hook functions
  loadAgents: () => void;
  updateAgents: (agents: AgentConfig[]) => void;
  handleAgentOperationResult: (result: any) => void;
  handleAgentImportPreviewResult: (previewData: any) => void;
  handleAgentImportResult: (result: any) => void;
  cleanupAgentsTimeout: () => void;

  // Callbacks
  showAlert: (type: AlertType, title: string, message: string) => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;

  // Props
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
}

/**
 * Registers window callbacks for Java bridge communication in settings view.
 * Handles provider, agent, prompt, config, and theme callbacks.
 */
export function useSettingsWindowCallbacks(deps: SettingsWindowCallbacksDeps) {
  const { t } = useTranslation();

  // Use ref to avoid stale closures - callbacks always read latest deps
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const d = () => depsRef.current;

    window.showError = (message: string) => {
      d().showAlert('error', t('toast.operationFailed'), message);
      d().setSavingClaudeCliPath(false);
      d().setSavingWorkingDirectory(false);
    };

    window.showSwitchSuccess = (message: string) => {
      d().showAlert('success', t('toast.switchSuccess'), message);
    };

    window.updateClaudeCliPath = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setClaudeCliPath(data.path || '');
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateClaudeCliPath JSON, fallback to legacy format:', e);
        d().setClaudeCliPath(jsonStr || '');
      }
      d().setSavingClaudeCliPath(false);
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setWorkingDirectory(data.customWorkingDir || '');
        d().setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        d().setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      d().showAlert('success', t('toast.operationSuccess'), message);
      d().setSavingClaudeCliPath(false);
      d().setSavingWorkingDirectory(false);
    };

    window.showSuccessI18n = (i18nKey: string) => {
      const message = t(i18nKey);
      d().addToast(message, 'success');
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setEditorFontConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse editor font config:', error);
      }
    };

    window.onUiFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setUiFontConfig(config);
        window.applyUiFontConfig?.(config);
      } catch {
        // Silently ignore malformed UI font config from backend
      }
    };

    window.onCodeFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setCodeFontConfig(config);
        window.applyCodeFontConfig?.(config);
      } catch {
        // Silently ignore malformed code font config from backend
      }
    };

    window.onVscodeFontListReceived = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        if (Array.isArray(data?.fonts)) {
          d().setVscodeFontList?.(data.fonts.filter((f: unknown) => typeof f === 'string'));
        }
      } catch {
        // Silently ignore malformed font list from backend
      }
    };

    window.onSystemFontListReceived = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const fonts = Array.isArray(data?.fonts)
          ? data.fonts.filter((f: unknown): f is string => typeof f === 'string')
          : [];
        d().setSystemFontList?.(fonts);
        d().setSystemFontError?.(typeof data?.error === 'string' ? data.error : null);
      } catch {
        // Silently ignore malformed font list from backend
      }
    };

    // IDE theme callback
    const previousOnIdeThemeReceived = window.onIdeThemeReceived;
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        d().setIdeTheme(theme);
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // Send shortcut configuration callback
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!d().onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          d().setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }


    // Task completion notification config callback (opt-in feature, default false)
    window.updateTaskCompletionNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setTaskCompletionNotificationEnabled?.(data.taskCompletionNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse task completion notification config:', error);
      }
    };

    // AskUserQuestion reminder notification config callback (opt-in feature, default false)
    window.updateAskUserQuestionNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setAskUserQuestionNotificationEnabled?.(data.askUserQuestionNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse ask user question notification config:', error);
      }
    };

    // System notification focus gate config callback (default false)
    window.updateSystemNotificationOnlyWhenUnfocused = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setSystemNotificationOnlyWhenUnfocused?.(data.systemNotificationOnlyWhenUnfocused ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse system notification focus config:', error);
      }
    };

    // AskUserQuestion reminder sound notification config callback (opt-in feature, default false)
    window.updateAskUserQuestionSoundNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setAskUserQuestionSoundNotificationEnabled?.(data.askUserQuestionSoundNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse ask user question sound notification config:', error);
      }
    };

    // Sound notification config callback
    window.updateSoundNotificationConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        if (data.enabled !== undefined) {
          d().setSoundNotificationEnabled?.(data.enabled);
        }
        if (data.onlyWhenUnfocused !== undefined) {
          d().setSoundOnlyWhenUnfocused?.(data.onlyWhenUnfocused);
        }
        if (data.selectedSound !== undefined) {
          d().setSelectedSound?.(data.selectedSound);
        }
        if (data.customSoundPath !== undefined) {
          d().setCustomSoundPath?.(data.customSoundPath);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse sound notification config:', error);
      }
    };

    // Agent callbacks
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        d().updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    // 自定义声音"浏览"：宿主 showOpenDialog 选完回填输入框（不自动保存，
    // 保留用户确认语义）。仅设置页挂载期间有效——浏览按钮只在此处出现。
    window.onSoundFileSelected = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr) as { path?: string };
        if (typeof data.path === 'string' && data.path.trim()) {
          d().setCustomSoundPath?.(data.path.trim());
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse selected sound file:', error);
      }
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    window.agentImportPreviewResult = (jsonStr: string) => {
      try {
        const previewData = JSON.parse(jsonStr);
        if (!Array.isArray(previewData?.items) || typeof previewData?.summary !== 'object') {
          console.error('[SettingsView] Invalid agent import preview data structure');
          return;
        }
        d().handleAgentImportPreviewResult(previewData);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import preview result:', error);
      }
    };

    window.agentImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentImportResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import result:', error);
      }
    };

    // Initial data loading for the default (basic) settings surface only.
    // Provider / agent / prompt lists are fetched when their tabs first mount.
    // Bootstrap messages are batched so open-settings does not stampede CEF.
    const bootstrapRequests = scheduleBatchedBridgeRequests({
      messages: SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES,
      batchSize: 5,
      batchDelayMs: 16,
      send: sendToJava,
    });

    return () => {
      bootstrapRequests.cancel();
      d().cleanupAgentsTimeout();

      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateClaudeCliPath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.showSuccessI18n = undefined;
      window.onEditorFontConfigReceived = undefined;
      window.onUiFontConfigReceived = undefined;
      window.onCodeFontConfigReceived = undefined;
      window.onVscodeFontListReceived = undefined;
      window.onSystemFontListReceived = undefined;
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      if (!d().onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateSoundNotificationConfig = undefined;
      window.onSoundFileSelected = undefined;
      window.updateTaskCompletionNotificationEnabled = undefined;
      window.updateAskUserQuestionNotificationEnabled = undefined;
      window.updateSystemNotificationOnlyWhenUnfocused = undefined;
      window.updateAskUserQuestionSoundNotificationEnabled = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      window.agentImportPreviewResult = undefined;
      window.agentImportResult = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
}
