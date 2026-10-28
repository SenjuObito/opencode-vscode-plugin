import type { CommandItem, DropdownItemData } from '../types';
import { sendHostCommand, sendWindowCommand } from '../../../utils/bridge';
import { getTabStore } from '../../../store/tabStore';
import { hostEventHandler, registerHostEvents } from '../../../utils/hostEventRegistry';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

/**
 * Local command list (commands to be filtered out)
 */
const HIDDEN_COMMANDS = new Set<string>([]);

/**
 * Local new session commands (/clear, /new, /reset are aliases for the same command)
 * These commands are handled directly on the frontend, no need to send to SDK
 */
const NEW_SESSION_COMMAND_ALIASES = new Set(['/clear', '/new', '/reset']);

function getLocalNewSessionCommands(): CommandItem[] {
  return [{
    id: 'clear',
    label: '/clear',
    description: i18n.t('chat.clearCommandDescription'),
    category: 'system',
  }];
}

/**
 * Builtin commands from opencode TUI/Web App
 * These are frontend-hardcoded commands not returned by the /command API
 */
const BUILTIN_COMMANDS: CommandItem[] = [
  {
    id: 'compact',
    label: '/compact',
    description: i18n.t('chat.builtinCommands.compact'),
    category: 'builtin',
  },
  {
    id: 'undo',
    label: '/undo',
    description: i18n.t('chat.builtinCommands.undo'),
    category: 'builtin',
  },
  {
    id: 'redo',
    label: '/redo',
    description: i18n.t('chat.builtinCommands.redo'),
    category: 'builtin',
  },
  {
    id: 'fork',
    label: '/fork',
    description: i18n.t('chat.builtinCommands.fork'),
    category: 'builtin',
  },
  {
    id: 'share',
    label: '/share',
    description: i18n.t('chat.builtinCommands.share'),
    category: 'builtin',
  },
  {
    id: 'unshare',
    label: '/unshare',
    description: i18n.t('chat.builtinCommands.unshare'),
    category: 'builtin',
  },
  {
    id: 'review',
    label: '/review',
    description: i18n.t('chat.builtinCommands.review'),
    category: 'builtin',
  },
  {
    id: 'init',
    label: '/init',
    description: i18n.t('chat.builtinCommands.init'),
    category: 'builtin',
  },
  {
    id: 'models',
    label: '/models',
    description: i18n.t('chat.builtinCommands.models'),
    category: 'builtin',
  },
  {
    id: 'themes',
    label: '/themes',
    description: i18n.t('chat.builtinCommands.themes'),
    category: 'builtin',
  },
  {
    id: 'help',
    label: '/help',
    description: i18n.t('chat.builtinCommands.help'),
    category: 'builtin',
  },
];

// ============================================================================
// State Management
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedSdkCommands: CommandItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
/**
 * 每个 tab 的命令列表（§10.14）。
 *
 * 命令是按目录发现的（自定义命令 / skill），不同 cwd 的 tab 看到的列表不同，
 * 所以列表必须按 tab 存；否则切到另一个 tab 时会显示上一个目录的命令。
 */
const commandsByTab = new Map<string, CommandItem[]>();
/** 每个 tab 的上次刷新时间：节流也要按 tab，否则切 tab 后会被上一次挡住。 */
const lastRefreshByTab = new Map<string, number>();
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 30000; // Increased to 30s to handle slow initial load for some Windows users
const MAX_RETRY_COUNT = 3;

// ============================================================================
// Core Functions
// ============================================================================

export function resetSlashCommandsState() {
  cachedSdkCommands = [];
  commandsByTab.clear();
  lastRefreshByTab.clear();
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Slash commands state reset')));
  pendingWaiters = [];
  debugLog('[SlashCommand] State reset');
}

interface SDKSlashCommand {
  name: string;
  description?: string;
  source?: string;
}

/**
 * 把宿主给的两种载荷（对象数组或名字数组）归一成 CommandItem。
 *
 * @returns null 表示载荷形状不认识
 */
function normalizeCommands(raw: unknown): CommandItem[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.length === 0) {
    return [];
  }
  if (typeof raw[0] === 'object' && raw[0] !== null && 'name' in (raw[0] as Record<string, unknown>)) {
    const sdkCommands = raw as SDKSlashCommand[];
    return sdkCommands.map(cmd => ({
      id: cmd.name.replace(/^\//, ''),
      label: cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`,
      description: formatCommandDescription(cmd.description || '', cmd.source),
      category: getCategoryFromCommand(cmd.name),
    }));
  }
  if (typeof raw[0] === 'string') {
    const commandNames = raw as string[];
    return commandNames.map(name => ({
      id: name.replace(/^\//, ''),
      label: name.startsWith('/') ? name : `/${name}`,
      description: '',
      category: getCategoryFromCommand(name),
    }));
  }
  return null;
}

/**
 * 应用一份命令列表。
 *
 * @param tabId 这份列表属于哪个 tab；null = 窗口级（没有归属）
 */
function applyCommands(commands: CommandItem[], tabId: string | null): void {
  if (tabId) {
    commandsByTab.set(tabId, commands);
  }
  const active = getTabStore().getActiveTabId();
  // 只有活跃 tab 的列表才影响当前下拉；后台 tab 的先存着。
  if (tabId && tabId !== active) {
    debugLog('[SlashCommand] cached commands for background tab', tabId, commands.length);
    return;
  }
  cachedSdkCommands = commands;
  loadingState = 'success';
  retryCount = 0;
  pendingWaiters.forEach(w => w.resolve());
  pendingWaiters = [];
  debugLog('[SlashCommand] Successfully loaded ' + commands.length + ' commands');
}

/** 切到某个 tab 时，若它已有缓存的列表，直接采用（不必等一次刷新）。 */
function adoptCachedCommandsForActiveTab(): boolean {
  const active = getTabStore().getActiveTabId();
  if (!active) {
    return false;
  }
  const cached = commandsByTab.get(active);
  if (!cached) {
    return false;
  }
  cachedSdkCommands = cached;
  loadingState = 'success';
  retryCount = 0;
  return true;
}

export function setupSlashCommandsCallback() {
  if (typeof window === 'undefined') return;
  // 已注册过（语义事件或 legacy 回调任一）就不再重复挂。
  if (callbackRegistered && (hostEventHandler('slash.commands') || window.updateSlashCommands)) return;

  const handler = (json: string) => {
    debugLog('[SlashCommand] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      // legacy 回退路径收到的是宿主事件载荷的包装（`{commands:[...]}` 或
      // `{data:"<json>"}`）；v2 语义事件收到的是解包后的数组。
      let raw: unknown = parsed;
      if (raw && !Array.isArray(raw) && typeof (raw as { data?: unknown }).data === 'string') {
        raw = JSON.parse((raw as { data: string }).data);
      }
      if (raw && !Array.isArray(raw)) {
        // 对象形态 = 某个 tab 的事件在 legacy 通道上的副本（事件路由器会同时投递
        // v2 批次与 legacy 回调）。归属由 v2 的 envelope.tabId 决定；这里再赋值，
        // 就会把别的 tab 的列表写到当前 tab 上。
        debugLog('[SlashCommand] ignoring per-tab legacy twin');
        return;
      }
      const commands = normalizeCommands(raw);
      if (commands === null) {
        loadingState = 'failed';
        const error = new Error('Slash commands payload is not an array');
        pendingWaiters.forEach(w => w.reject(error));
        pendingWaiters = [];
        debugWarn('[SlashCommand] Invalid commands payload');
        return;
      }
      // 窗口级回放（legacy 回调）没有 tab 身份，归给当前活跃 tab。
      applyCommands(commands, getTabStore().getActiveTabId());
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[SlashCommand] Failed to parse commands:', error);
    }
  };

  const originalHandler = window.updateSlashCommands;

  window.updateSlashCommands = (json: string) => {
    handler(json);
    originalHandler?.(json);
  };

  // v2 语义事件：宿主按 tab 投回 `slash.commands`（命名事件，带 envelope.tabId）。
  registerHostEvents({
    'slash.commands': (payload: unknown, envelope?: { tabId?: string | null }) => {
      const raw = (payload as { commands?: unknown } | null)?.commands;
      const commands = normalizeCommands(raw);
      if (commands === null) {
        debugWarn('[SlashCommand] Invalid slash.commands payload');
        return;
      }
      applyCommands(commands, envelope?.tabId ?? null);
    },
  });

  callbackRegistered = true;
  debugLog('[SlashCommand] Callback registered');

  if (window.__pendingSlashCommands) {
    debugLog('[SlashCommand] Processing pending commands');
    const pending = window.__pendingSlashCommands;
    window.__pendingSlashCommands = undefined;
    handler(pending);
  }
}

function waitForSlashCommands(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (loadingState === 'success') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const waiter = { resolve: () => {}, reject: (_error: unknown) => {} } as {
      resolve: () => void;
      reject: (error: unknown) => void;
    };

    const cleanup = () => {
      pendingWaiters = pendingWaiters.filter(w => w !== waiter);
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Slash commands loading timeout'));
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error: unknown) => {
      cleanup();
      reject(error);
    };

    pendingWaiters.push(waiter);
    if (loadingState === 'success') {
      waiter.resolve();
    } else if (loadingState === 'failed') {
      waiter.reject(new Error('Slash commands loading failed'));
    }
  });
}

function requestRefresh(): boolean {
  const now = Date.now();
  const tabId = getTabStore().getActiveTabId() ?? '';

  // 节流按 tab：切到另一个 tab 时不该被上一个 tab 的刷新挡住。
  const lastForTab = lastRefreshByTab.get(tabId) ?? 0;
  if (now - lastForTab < MIN_REFRESH_INTERVAL) {
    debugLog('[SlashCommand] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[SlashCommand] Max retry count reached');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  // 按 tab 刷新：命令列表依赖目标 tab 的 cwd（自定义命令/skill 是按目录发现的）。
  // 没有活跃 tab（启动早期）时退回窗口级命令，宿主用默认目录列举。
  const activeTabId = getTabStore().getActiveTabId();
  const sent = activeTabId
    ? sendHostCommand(activeTabId, 'commands.refresh')
    : sendWindowCommand('commands.refresh');
  if (!sent) {
    debugLog('[SlashCommand] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  lastRefreshByTab.set(tabId, now);
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[SlashCommand] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function isHiddenCommand(name: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  if (HIDDEN_COMMANDS.has(normalized)) return true;
  // Hide SDK-returned /clear (use local version instead)
  if (NEW_SESSION_COMMAND_ALIASES.has(normalized)) return true;
  const baseName = normalized.split(' ')[0];
  return HIDDEN_COMMANDS.has(baseName) || NEW_SESSION_COMMAND_ALIASES.has(baseName);
}

function getCategoryFromCommand(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('workflow')) return 'workflow';
  if (lowerName.includes('memory') || lowerName.includes('skill')) return 'memory';
  if (lowerName.includes('task')) return 'task';
  if (lowerName.includes('speckit')) return 'speckit';
  if (lowerName.includes('cli')) return 'cli';
  return 'user';
}

function formatCommandDescription(description: string, source?: string): string {
  if (!source) return description;
  const suffix = `[${source}]`;
  if (!description) return suffix;
  return `${description} ${suffix}`;
}

function normalizeCommandLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const visibleCommands = commands.filter(cmd => !isHiddenCommand(cmd.label));
  const localCommands = getLocalNewSessionCommands();

  // Deduplicate by normalized label
  const commandMap = new Map<string, CommandItem>();

  // 1. Add visibleCommands (from backend / API / skills)
  for (const cmd of visibleCommands) {
    const key = normalizeCommandLabel(cmd.label);
    commandMap.set(key, cmd);
  }

  // 2. Add localCommands (e.g. /clear)
  for (const cmd of localCommands) {
    const key = normalizeCommandLabel(cmd.label);
    commandMap.set(key, cmd);
  }

  // 3. Add BUILTIN_COMMANDS (preserve builtin localized descriptions and category)
  for (const cmd of BUILTIN_COMMANDS) {
    const key = normalizeCommandLabel(cmd.label);
    const existing = commandMap.get(key);
    commandMap.set(key, {
      ...cmd,
      ...(existing || {}),
      id: cmd.id,
      label: cmd.label,
      description: cmd.description || existing?.description || '',
      category: 'builtin',
    });
  }

  const merged = Array.from(commandMap.values());

  if (!query) return merged;

  const lowerQuery = query.toLowerCase();
  return merged.filter(cmd =>
    cmd.label.toLowerCase().includes(lowerQuery) ||
    cmd.description?.toLowerCase().includes(lowerQuery) ||
    cmd.id.toLowerCase().includes(lowerQuery)
  );
}

export async function slashCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupSlashCommandsCallback();

  const now = Date.now();

  // 切 tab 后先看这个 tab 有没有缓存的列表：有就直接用，没有才去刷新。
  const hasCachedForActiveTab = adoptCachedCommandsForActiveTab();

  if (hasCachedForActiveTab) {
    return filterCommands(cachedSdkCommands, query);
  }

  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[SlashCommand] Loading timeout');
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForSlashCommands(signal, LOADING_TIMEOUT).catch(() => {});
  }

  if (loadingState === 'success') {
    return filterCommands(cachedSdkCommands, query);
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    return [{
      id: '__error__',
      label: i18n.t('chat.loadingFailed'),
      description: i18n.t('chat.pleaseCloseAndReopen'),
      category: 'system',
    }];
  }

  return [{
    id: '__loading__',
    label: i18n.t('chat.loadingSlashCommands'),
    description: retryCount > 0 ? i18n.t('chat.retrying', { count: retryCount, max: MAX_RETRY_COUNT }) : i18n.t('chat.pleaseWait'),
    category: 'system',
  }];
}

export function commandToDropdownItem(command: CommandItem): DropdownItemData {
  return {
    id: command.id,
    label: command.label,
    description: command.description,
    icon: 'codicon-terminal',
    type: 'command',
    data: { command },
  };
}

export function forceRefreshSlashCommands(): void {
  debugLog('[SlashCommand] Force refresh requested');
  loadingState = 'idle';
  lastRefreshTime = 0;
  lastRefreshByTab.delete(getTabStore().getActiveTabId() ?? '');
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Slash commands refresh requested')));
  pendingWaiters = [];
  requestRefresh();
}

/**
 * Preload slash commands during app initialization
 * Load command data before user types "/" to improve perceived performance
 *
 * Safety guarantees:
 * - Skips if already loading or loaded (checks loadingState)
 * - requestRefresh() has MIN_REFRESH_INTERVAL deduplication protection
 * - Shares state with slashCommandProvider, subsequent calls hit cache directly
 */
export function preloadSlashCommands(): void {
  // Only preload in idle state, don't interfere with in-progress or completed loads
  if (loadingState !== 'idle') {
    debugLog('[SlashCommand] Preload skipped (state=' + loadingState + ')');
    return;
  }

  debugLog('[SlashCommand] Preloading commands on app init');

  // Ensure callback is registered before requesting refresh
  setupSlashCommandsCallback();

  // Request refresh -- built-in deduplication protection
  requestRefresh();
}

export default slashCommandProvider;
