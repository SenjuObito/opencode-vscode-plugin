/**
 * UI preferences — single source of truth for the appearance / behaviour
 * settings that the webview owns.
 *
 * Historically every one of these settings lived **only** in webview
 * `localStorage`. VS Code tears down and recreates webviews (tab switch, window
 * reload, workspace change), and the storage does not always survive that — so
 * users saw settings silently reset. The extension host now keeps an
 * authoritative copy in `globalState`:
 *
 *   - at HTML build time the host inlines the persisted values
 *     (`window.__INITIAL_UI_PREFERENCES__`) so the very first paint is correct;
 *   - on bridge ready the webview asks for `get_ui_preferences`;
 *   - every local change is mirrored back via `set_ui_preferences`.
 *
 * `localStorage` is still written as a mirror because several legacy readers
 * (tool blocks, dialogs) read those keys directly. Values present in
 * localStorage win over the host copy at first read, so an existing user's
 * current on-disk choice is never downgraded to a default on upgrade.
 */
import { sendBridgeEvent } from './bridge';
import { getStoredDiffTheme, type DiffThemeMode } from './diffTheme';
import { CHAT_BAR_COLOR_STORAGE_KEY } from './chatBarTheme';

export interface UiPreferences {
  /** 'system' = follow the VS Code color theme. */
  theme: 'light' | 'dark' | 'system';
  /** 1..6, see the fontSizeMap in useThemeInit / useSettingsThemeSync. */
  fontSizeLevel: number;
  chatBgColor: string;
  userMsgColor: string;
  chatBarColor: string;
  diffTheme: DiffThemeMode;
  diffExpandedByDefault: boolean;
  historyCompletionEnabled: boolean;
  skipNewSessionConfirm: boolean;
  detailedOutputEnabled: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'system',
  fontSizeLevel: 2,
  chatBgColor: '',
  userMsgColor: '',
  chatBarColor: '',
  diffTheme: 'follow',
  diffExpandedByDefault: false,
  historyCompletionEnabled: true,
  skipNewSessionConfirm: false,
  detailedOutputEnabled: false,
};

export const UI_PREFERENCES_CHANGED_EVENT = 'ui-preferences-changed';

export interface UiPreferencesChangedDetail {
  preferences: UiPreferences;
  /** 'host' = pushed by the extension host; 'local' = changed in this webview. */
  source: 'host' | 'local';
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const THEMES: UiPreferences['theme'][] = ['light', 'dark', 'system'];
const DIFF_THEMES: DiffThemeMode[] = ['follow', 'editor', 'light', 'soft-dark'];

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  try {
    if (value === '') {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (sandboxed context) — the host copy still wins.
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readString(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

function readInt(key: string, fallback: number): number {
  const raw = readString(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : undefined;
}

/** Drop unknown / malformed fields so a corrupted payload cannot poison the UI. */
function sanitize(patch: unknown): Partial<UiPreferences> {
  if (!patch || typeof patch !== 'object') return {};
  const raw = patch as Record<string, unknown>;
  const out: Partial<UiPreferences> = {};

  if (typeof raw.theme === 'string' && THEMES.includes(raw.theme as UiPreferences['theme'])) {
    out.theme = raw.theme as UiPreferences['theme'];
  }
  if (typeof raw.fontSizeLevel === 'number' && Number.isFinite(raw.fontSizeLevel)) {
    out.fontSizeLevel = Math.min(6, Math.max(1, Math.trunc(raw.fontSizeLevel)));
  }
  const colors: Array<keyof Pick<UiPreferences, 'chatBgColor' | 'userMsgColor' | 'chatBarColor'>> = [
    'chatBgColor',
    'userMsgColor',
    'chatBarColor',
  ];
  for (const key of colors) {
    const value = normalizeColor(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  if (typeof raw.diffTheme === 'string' && DIFF_THEMES.includes(raw.diffTheme as DiffThemeMode)) {
    out.diffTheme = raw.diffTheme as DiffThemeMode;
  }
  const bools: Array<keyof Pick<UiPreferences,
    'diffExpandedByDefault' | 'historyCompletionEnabled' | 'skipNewSessionConfirm' | 'detailedOutputEnabled'>> = [
    'diffExpandedByDefault',
    'historyCompletionEnabled',
    'skipNewSessionConfirm',
    'detailedOutputEnabled',
  ];
  for (const key of bools) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  return out;
}

/** Read the legacy localStorage mirror (only keys that were actually persisted). */
function readLocalMirror(): Partial<UiPreferences> {
  const partial: Partial<UiPreferences> = {};
  const theme = readString('theme');
  if (theme !== null && THEMES.includes(theme as UiPreferences['theme'])) {
    partial.theme = theme as UiPreferences['theme'];
  }
  if (readString('fontSizeLevel') !== null) {
    partial.fontSizeLevel = Math.min(6, Math.max(1, readInt('fontSizeLevel', 2)));
  }
  for (const key of ['chatBgColor', 'userMsgColor'] as const) {
    const value = readString(key);
    if (value !== null) partial[key] = value;
  }
  const chatBar = readString(CHAT_BAR_COLOR_STORAGE_KEY);
  if (chatBar !== null) partial.chatBarColor = chatBar;
  // 只有真正写过才覆盖宿主值 —— getStoredDiffTheme() 在键缺失时也会返回
  // 'follow'，无条件采用会把宿主演化的非默认档位打回默认。
  if (readString('diffTheme') !== null) {
    partial.diffTheme = getStoredDiffTheme();
  }
  for (const key of [
    'diffExpandedByDefault',
    'historyCompletionEnabled',
    'skipNewSessionConfirm',
    'detailedOutputEnabled',
  ] as const) {
    if (readString(key) !== null) partial[key] = readBool(key, false);
  }
  return partial;
}

function readInitialPreferences(): UiPreferences {
  const injected = (window as { __INITIAL_UI_PREFERENCES__?: unknown }).__INITIAL_UI_PREFERENCES__;
  return {
    ...DEFAULT_UI_PREFERENCES,
    ...sanitize(injected),
    ...readLocalMirror(),
  };
}

let current: UiPreferences = readInitialPreferences();
/** Last JSON exchanged with the host — used to suppress redundant round-trips. */
let lastSyncedJson = '';

export function getUiPreferences(): UiPreferences {
  return current;
}

function writeLocalMirror(prefs: UiPreferences): void {
  writeString('theme', prefs.theme);
  writeString('fontSizeLevel', String(prefs.fontSizeLevel));
  writeString('chatBgColor', prefs.chatBgColor);
  writeString('userMsgColor', prefs.userMsgColor);
  writeString(CHAT_BAR_COLOR_STORAGE_KEY, prefs.chatBarColor);
  writeString('diffTheme', prefs.diffTheme);
  writeString('diffExpandedByDefault', prefs.diffExpandedByDefault ? 'true' : 'false');
  writeString('historyCompletionEnabled', prefs.historyCompletionEnabled ? 'true' : 'false');
  writeString('skipNewSessionConfirm', prefs.skipNewSessionConfirm ? 'true' : 'false');
  writeString('detailedOutputEnabled', prefs.detailedOutputEnabled ? 'true' : 'false');
}

function emit(source: UiPreferencesChangedDetail['source']): void {
  window.dispatchEvent(new CustomEvent<UiPreferencesChangedDetail>(
    UI_PREFERENCES_CHANGED_EVENT,
    { detail: { preferences: current, source } },
  ));
}

/**
 * Apply an authoritative snapshot pushed by the extension host.
 * Wins over the local mirror and rewrites it so legacy readers stay consistent.
 */
export function applyHostUiPreferences(patch: unknown): void {
  const next: UiPreferences = { ...current, ...sanitize(patch) };
  const unchanged = JSON.stringify(next) === JSON.stringify(current);
  current = next;
  lastSyncedJson = JSON.stringify(current);
  writeLocalMirror(current);
  if (!unchanged) {
    emit('host');
  }
}

/**
 * Record a local change: mirrors to localStorage, notifies in-tab subscribers
 * and (only when the value actually differs from the last exchange) persists to
 * the extension host.
 */
export function updateUiPreferences(patch: Partial<UiPreferences>): void {
  const next: UiPreferences = { ...current, ...patch };
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return;
  }
  current = next;
  writeLocalMirror(current);
  emit('local');

  const serialized = JSON.stringify(current);
  if (serialized !== lastSyncedJson) {
    lastSyncedJson = serialized;
    sendBridgeEvent('set_ui_preferences', serialized);
  }
}

/** Ask the extension host for the authoritative preferences. */
export function requestUiPreferences(): void {
  sendBridgeEvent('get_ui_preferences');
}

/**
 * Register `window.applyUiPreferences` (the host callback).
 * Safe to call more than once; returns a disposer.
 */
export function installUiPreferencesBridge(): () => void {
  const handler = (json: string) => {
    let parsed: unknown = json;
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json);
      } catch {
        return;
      }
    }
    applyHostUiPreferences(parsed);
  };
  window.applyUiPreferences = handler;
  return () => {
    if (window.applyUiPreferences === handler) {
      delete window.applyUiPreferences;
    }
  };
}
