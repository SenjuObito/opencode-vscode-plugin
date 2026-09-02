// hooks/useSettingsThemeSync.ts
import { useState, useEffect, useCallback } from 'react';
import { sendBridgeEvent } from '../../../utils/bridge';
import { applyDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import { applyChatBarThemeColor } from '../../../utils/chatBarTheme';
import { applyFontScale } from '../../../utils/fontScale';
import {
  getUiPreferences,
  updateUiPreferences,
  UI_PREFERENCES_CHANGED_EVENT,
  type UiPreferences,
  type UiPreferencesChangedDetail,
} from '../../../utils/uiPreferences';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: 'light' | 'dark';
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: 'light' | 'dark' | 'system';
  setThemePreference: (theme: 'light' | 'dark' | 'system') => void;
  ideTheme: 'light' | 'dark' | null;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  chatBarColor: string;
  setChatBarColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  // 初值来自共享偏好仓库（宿主注入的权威值 + localStorage 镜像），
  // 不是裸读 localStorage —— 否则 webview 重建后设置会回到默认值。
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(
    () => getUiPreferences().theme,
  );

  // IDE theme state (prefer Java-injected initial theme, used to handle dynamic changes)
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java has injected the initial theme
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6, default is 2, i.e. 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => getUiPreferences().fontSizeLevel);

  // Chat background color configuration
  const [chatBgColor, setChatBgColor] = useState<string>(() => getUiPreferences().chatBgColor);

  // User message bubble color configuration
  const [userMsgColor, setUserMsgColor] = useState<string>(() => getUiPreferences().userMsgColor);

  // Shared chat header and status bar color configuration
  const [chatBarColor, setChatBarColor] = useState<string>(() => getUiPreferences().chatBarColor);

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getUiPreferences().diffTheme);

  // 宿主推送权威偏好（get_ui_preferences / set_ui_preferences 回包）时同步本地状态。
  // 只认 source==='host'，避免自己刚发出的改动被回弹。
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<UiPreferencesChangedDetail>).detail;
      if (detail?.source !== 'host' || !detail.preferences) return;
      const next: UiPreferences = detail.preferences;
      setThemePreference(next.theme);
      setFontSizeLevel(next.fontSizeLevel);
      setChatBgColor(next.chatBgColor);
      setUserMsgColor(next.userMsgColor);
      setChatBarColor(next.chatBarColor);
      setDiffTheme(next.diffTheme);
    };
    window.addEventListener(UI_PREFERENCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(UI_PREFERENCES_CHANGED_EVENT, onChanged);
  }, []);

  /**
   * 选择「跟随 VS Code」时主动向宿主要一次当前主题：
   * VS Code 宿主不注入 __INITIAL_IDE_THEME__，本 hook 的 ideTheme 初始为 null，
   * 不拉取的话 applyTheme('system') 会因 ideTheme===null 早退（表现为点击无反应）。
   * 宿主回推 onIdeThemeReceived → 设置页回调包装器链式更新 ideTheme → 下方 effect 应用主题。
   */
  const handleSetThemePreference = useCallback((theme: 'light' | 'dark' | 'system') => {
    setThemePreference(theme);
    if (theme === 'system') {
      sendBridgeEvent('get_ide_theme');
    }
  }, []);

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (preference === 'system') {
        // If following IDE, need to wait for IDE theme to load
        if (ideTheme === null) {
          return; // Wait for ideTheme to load
        }
        document.documentElement.setAttribute('data-theme', ideTheme);
      } else {
        // Explicit light/dark selection, apply immediately
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // 写入共享偏好仓库 → localStorage 镜像 + 宿主 globalState
    updateUiPreferences({ theme: themePreference });
  }, [themePreference, ideTheme]);

  // Font size scaling handler
  useEffect(() => {
    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (default)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // Apply to root element (also clears any stale inline zoom on #app)
    applyFontScale(scale.toString());

    updateUiPreferences({ fontSizeLevel });
  }, [fontSizeLevel]);

  // Chat background color handler
  useEffect(() => {
    if (chatBgColor) {
      document.documentElement.style.setProperty('--bg-chat', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
    }
    updateUiPreferences({ chatBgColor });
  }, [chatBgColor]);

  // User message bubble color handler
  useEffect(() => {
    if (userMsgColor) {
      document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
    } else {
      document.documentElement.style.removeProperty('--color-message-user-bg');
    }
    updateUiPreferences({ userMsgColor });
  }, [userMsgColor]);

  // Shared chat header and status bar color handler
  useEffect(() => {
    applyChatBarThemeColor(chatBarColor);
    updateUiPreferences({ chatBarColor });
  }, [chatBarColor]);

  // Diff theme handler（applyDiffTheme 内部会写 localStorage 镜像）
  useEffect(() => {
    applyDiffTheme(diffTheme, ideTheme);
    updateUiPreferences({ diffTheme });
  }, [diffTheme, ideTheme, themePreference]);

  return {
    themePreference,
    setThemePreference: handleSetThemePreference,
    ideTheme,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    chatBarColor,
    setChatBarColor,
    diffTheme,
    setDiffTheme,
  };
}
