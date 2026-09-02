import { useEffect, useRef, useState } from 'react';
import { applyChatBarThemeColor, isValidHexColor } from '../utils/chatBarTheme';
import { applyFontScale } from '../utils/fontScale';
import {
  getUiPreferences,
  UI_PREFERENCES_CHANGED_EVENT,
  type UiPreferences,
  type UiPreferencesChangedDetail,
} from '../utils/uiPreferences';

/** 字号档位 → 缩放比（与设置页保持一致的唯一映射）。 */
const FONT_SIZE_SCALE: Record<number, number> = {
  1: 0.8,   // 80%
  2: 0.9,   // 90% (default)
  3: 1.0,   // 100%
  4: 1.1,   // 110%
  5: 1.2,   // 120%
  6: 1.4,   // 140%
};

function applyAppearance(prefs: UiPreferences, ideTheme: 'light' | 'dark' | null): void {
  // 显式 light/dark 立即生效；跟随 IDE 时等 ideTheme 到达再切换。
  // 旧实现无条件等 ideTheme，导致「选了浅色却先闪一帧暗色」。
  if (prefs.theme === 'light' || prefs.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', prefs.theme);
  } else if (ideTheme !== null) {
    document.documentElement.setAttribute('data-theme', ideTheme);
  }

  applyFontScale(String(FONT_SIZE_SCALE[prefs.fontSizeLevel] ?? 1.0));

  if (prefs.chatBgColor && isValidHexColor(prefs.chatBgColor)) {
    document.documentElement.style.setProperty('--bg-chat', prefs.chatBgColor);
  } else {
    document.documentElement.style.removeProperty('--bg-chat');
  }

  if (prefs.userMsgColor && isValidHexColor(prefs.userMsgColor)) {
    document.documentElement.style.setProperty('--color-message-user-bg', prefs.userMsgColor);
  } else {
    document.documentElement.style.removeProperty('--color-message-user-bg');
  }

  applyChatBarThemeColor(prefs.chatBarColor);
}

/**
 * Manages IDE theme initialization and synchronization.
 * Handles font scaling, background color, and theme mode detection.
 *
 * Theme source of truth is the shared uiPreferences store (host globalState +
 * localStorage mirror), so the very first render already uses the persisted
 * choice instead of the CSS default (dark).
 */
export function useThemeInit() {
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // 最新主题 / IDE 主题保存在 ref 里，供偏好变更事件复用（避免每次重渲染都重建监听）。
  const ideThemeRef = useRef(ideTheme);
  ideThemeRef.current = ideTheme;

  // Initialize theme and font scaling
  useEffect(() => {
    // 设置页（useSettingsWindowCallbacks）会在这两个回调上再包一层来同步自己的
    // ideTheme state；卸载时只回收自己装的那一层，绝不误删别人的包装器。
    const onReceived = (jsonStr: string): void => {
      try {
        const themeData = JSON.parse(jsonStr);
        setIdeTheme(themeData.isDark ? 'dark' : 'light');
      } catch {
        // Failed to parse IDE theme response
      }
    };
    const onChanged = (jsonStr: string): void => {
      try {
        const themeData = JSON.parse(jsonStr);
        setIdeTheme(themeData.isDark ? 'dark' : 'light');
      } catch {
        // Failed to parse IDE theme change
      }
    };

    window.onIdeThemeReceived = onReceived;
    window.onIdeThemeChanged = onChanged;

    return () => {
      if (window.onIdeThemeReceived === onReceived) delete window.onIdeThemeReceived;
      if (window.onIdeThemeChanged === onChanged) delete window.onIdeThemeChanged;
    };
  }, []);

  // Apply appearance whenever the persisted preferences or the IDE theme change.
  useEffect(() => {
    applyAppearance(getUiPreferences(), ideTheme);
  }, [ideTheme]);

  useEffect(() => {
    const onPreferencesChanged = (event: Event) => {
      const detail = (event as CustomEvent<UiPreferencesChangedDetail>).detail;
      if (detail?.preferences) {
        applyAppearance(detail.preferences, ideThemeRef.current);
      }
    };
    window.addEventListener(UI_PREFERENCES_CHANGED_EVENT, onPreferencesChanged);
    return () => window.removeEventListener(UI_PREFERENCES_CHANGED_EVENT, onPreferencesChanged);
  }, []);

  // Request IDE theme (with retry mechanism)
  useEffect(() => {
    const savedTheme = getUiPreferences().theme;

    // Check if there's an initial theme injected by Java
    const injectedTheme = window.__INITIAL_IDE_THEME__;

    let retryCount = 0;
    const MAX_RETRIES = 20; // Max 20 retries (2 seconds)
    let cancelled = false;

    const requestIdeTheme = () => {
      if (cancelled) return;
      if (window.sendToJava) {
        window.sendToJava('get_ide_theme:');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          setTimeout(requestIdeTheme, 100);
        } else if (savedTheme === null || savedTheme === 'system') {
          // If in Follow IDE mode and unable to get IDE theme, use injected theme or dark as fallback
          const fallback = injectedTheme || 'dark';
          setIdeTheme(fallback as 'light' | 'dark');
        }
      }
    };

    // Delay 100ms before requesting, giving the bridge time to initialize
    const timer = setTimeout(requestIdeTheme, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { ideTheme };
}
