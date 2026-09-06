import type { DropdownItemData } from '../types';
import type { AgentConfig } from '../../../types/agent';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface AgentItem {
  id: string;
  name: string;
  prompt?: string;
  /** opencode agent mode: 'primary' = 主代理(Build/Plan/自定义), 'subagent' = 子代理(General/Explore/Scout), 'all' = 聚合 */
  mode?: 'primary' | 'subagent' | 'all' | string;
  /** 隐藏的系统代理(Compaction/Title/Summary) 不对外暴露 */
  hidden?: boolean;
  /** 简短描述 */
  description?: string;
}

/**
 * 子代理提及项（@ 下拉中用于唤起子代理）。
 * name 即 opencode 的 agent 标识，插入输入框时写作 `@name `。
 */
export interface SubagentMentionItem {
  /** agent 标识（插入文本用） */
  name: string;
  /** 展示名 */
  label: string;
  /** 描述（prompt 或 description） */
  description?: string;
}

// ============================================================================
// State Management
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedAgents: AgentItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
const subscribers = new Set<() => void>();

/** Fallback primary agents used until the backend list loads. */
export const FALLBACK_PRIMARY_AGENTS: AgentItem[] = [
  { id: 'build', name: 'Build', mode: 'primary', description: '', prompt: '' },
  { id: 'plan', name: 'Plan', mode: 'primary', description: '', prompt: '' },
];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 3000; // Reduced to 3s for faster timeout feedback
const MAX_RETRY_COUNT = 2; // Max 2 retries to avoid infinite loops

// ============================================================================
// Core Functions
// ============================================================================

function notifySubscribers() {
  subscribers.forEach(cb => {
    try { cb(); } catch (e) { debugError('[AgentProvider] Subscriber error:', e); }
  });
}

export function resetAgentsState() {
  cachedAgents = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Agents state reset')));
  pendingWaiters = [];
  notifySubscribers();
  debugLog('[AgentProvider] State reset');
}

export function subscribeAgents(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function unsubscribeAgents(callback: () => void): void {
  subscribers.delete(callback);
}

export function setupAgentsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateAgents) return;

  const handler = (json: string) => {
    debugLog('[AgentProvider] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let agents: AgentItem[] = [];

      if (Array.isArray(parsed)) {
        agents = parsed.map((agent: AgentConfig) => ({
          id: agent.id,
          name: agent.name,
          prompt: agent.prompt,
          mode: agent.mode,
          hidden: agent.hidden,
          description: agent.description,
        }));
      }

      cachedAgents = agents;
      loadingState = 'success';
      retryCount = 0; // Reset retry count on success
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      notifySubscribers();
      debugLog('[AgentProvider] Successfully loaded ' + agents.length + ' agents');
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[AgentProvider] Failed to parse agents:', error);
    }
  };

  // Save original callback
  const originalHandler = window.updateAgents;

  window.updateAgents = (json: string) => {
    // Call our handler
    handler(json);
    // Also call original handler (if exists)
    originalHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[AgentProvider] Callback registered');
}

function waitForAgents(signal: AbortSignal, timeoutMs: number): Promise<void> {
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
      reject(new Error('Agents loading timeout'));
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
  });
}

function requestRefresh(): boolean {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[AgentProvider] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[AgentProvider] Max retry count reached, giving up');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('get_agents');
  if (!sent) {
    debugLog('[AgentProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[AgentProvider] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function filterAgents(agents: AgentItem[], query: string): AgentItem[] {
  if (!query) return agents;

  const lowerQuery = query.toLowerCase();
  return agents.filter(agent =>
    agent.name.toLowerCase().includes(lowerQuery) ||
    agent.prompt?.toLowerCase().includes(lowerQuery)
  );
}

export const CREATE_NEW_AGENT_ID = '__create_new__';
export const EMPTY_STATE_ID = '__empty_state__';

export async function agentProvider(
  query: string,
  signal: AbortSignal
): Promise<AgentItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupAgentsCallback();

  const now = Date.now();
  
  // Create new agent item
  const createNewAgentItem: AgentItem = {
    id: CREATE_NEW_AGENT_ID,
    name: i18n.t('settings.agent.createAgent'),
    prompt: '',
  };

  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[AgentProvider] Loading timeout');
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForAgents(signal, LOADING_TIMEOUT).catch(() => {});
  }

  if (loadingState !== 'success') {
    return [{
      id: EMPTY_STATE_ID,
      name: retryCount >= MAX_RETRY_COUNT ? i18n.t('settings.agent.loadFailed') : i18n.t('settings.agent.noAgentsDropdown'),
      prompt: '',
    }, createNewAgentItem];
  }

  const filtered = cachedAgents.length > 0 ? filterAgents(cachedAgents, query) : [];

  if (filtered.length === 0) {
    return [{
      id: EMPTY_STATE_ID,
      name: i18n.t('settings.agent.noAgentsDropdown'),
      prompt: '',
    }, createNewAgentItem];
  }

  return [...filtered, createNewAgentItem];
}

/**
 * Synchronously return primary agents (mode==='primary' && !hidden) from the cache.
 * Used by the mode selector. Falls back to built-in build/plan agents.
 */
export function getPrimaryAgentsSync(query = '', includeFallback = true): AgentItem[] {
  const source = cachedAgents.length > 0 ? cachedAgents : (includeFallback ? FALLBACK_PRIMARY_AGENTS : []);
  // opencode agents may omit `mode` for legacy/default primary agents; treat missing
  // or 'all' as primary unless explicitly hidden or a subagent.
  const primaries = source.filter(
    a => !a.hidden && (a.mode === 'primary' || a.mode === 'all' || a.mode == null)
  );
  if (!query) return primaries;
  const q = query.toLowerCase();
  return primaries.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Synchronously return subagents (mode==='subagent' && !hidden) from the cache.
 * Used by the @ mention dropdown. Returns [] until agents have loaded.
 */
export function getSubagentsSync(query = ''): AgentItem[] {
  const subs = cachedAgents.filter(
    a => a.mode === 'subagent' && !a.hidden
  );
  if (!query) return subs;
  const q = query.toLowerCase();
  return subs.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.prompt?.toLowerCase().includes(q) ?? false) ||
    (a.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Trigger a backend refresh if agents haven't been loaded yet, so the @ mention
 * dropdown can show subagents without waiting for the settings panel to open.
 */
export function ensureAgentsLoaded(): void {
  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  }
}

/**
 * Provider for the @ mention dropdown: returns subagents only (no create-new /
 * empty-state noise). Falls back to [] if agents failed to load — the file
 * portion of the @ dropdown still works independently.
 */
export async function subagentMentionProvider(
  query: string,
  signal: AbortSignal
): Promise<SubagentMentionItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupAgentsCallback();

  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && Date.now() - lastRefreshTime > LOADING_TIMEOUT) {
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForAgents(signal, LOADING_TIMEOUT).catch(() => {});
  }

  return getSubagentsSync(query).map((a) => ({
    name: a.name,
    label: a.name,
    // Prefer the SDK's short description; fall back to a truncated prompt so the
    // dropdown tooltip never explodes with the full agent prompt.
    description: a.description || (a.prompt && a.prompt.length > 80 ? a.prompt.substring(0, 80) + '...' : a.prompt),
  }));
}

/**
 * Inline SVG robot icon (16x16, currentColor). Codicon font glyphs sit on the
 * text baseline and render ~1px higher than the file list's inline SVG icons;
 * using an SVG here routes through the exact same 16x16 flex-centered box as
 * file icons, so subagent and file icons align perfectly.
 */
const SUBAGENT_SVG_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M8 1a.72.72 0 0 1 .72.72V2.5h2.53A2.25 2.25 0 0 1 13.5 4.75v5a2.25 2.25 0 0 1-2.25 2.25h-.5v1.28a.72.72 0 0 1-1.44 0V12H6.69v1.28a.72.72 0 0 1-1.44 0V12h-.5A2.25 2.25 0 0 1 2.5 9.75v-5A2.25 2.25 0 0 1 4.75 2.5h2.53v-.78A.72.72 0 0 1 8 1zM4.75 3.94a.81.81 0 0 0-.81.81v5c0 .45.36.81.81.81h6.5c.45 0 .81-.36.81-.81v-5a.81.81 0 0 0-.81-.81h-6.5zM5.6 6.1a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm4.8 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM7 7h2v1.4H7V7z"/>' +
  '</svg>';

/**
 * Convert a SubagentMentionItem to a dropdown entry (inline-SVG robot icon,
 * 'agent' type).
 */
export function subagentMentionToDropdownItem(item: SubagentMentionItem): DropdownItemData {
  return {
    id: `subagent:${item.name}`,
    label: item.label,
    description: item.description,
    icon: SUBAGENT_SVG_ICON,
    type: 'agent',
    data: { subagent: item },
  };
}

export function agentToDropdownItem(agent: AgentItem): DropdownItemData {
  // Special handling for loading and empty states
  if (agent.id === '__loading__' || agent.id === '__empty__' || agent.id === EMPTY_STATE_ID) {
    return {
      id: agent.id,
      label: agent.name,
      description: agent.prompt,
      icon: agent.id === EMPTY_STATE_ID ? 'codicon-info' : 'codicon-robot',
      type: 'info',
      data: { agent },
    };
  }
  
  // Special handling for create agent item
  if (agent.id === CREATE_NEW_AGENT_ID) {
    return {
      id: agent.id,
      label: agent.name,
      description: i18n.t('settings.agent.createAgentHint'),
      icon: 'codicon-add',
      type: 'agent',
      data: { agent },
    };
  }

  return {
    id: agent.id,
    label: agent.name,
    description: agent.prompt ?
      (agent.prompt.length > 60 ? agent.prompt.substring(0, 60) + '...' : agent.prompt) :
      undefined,
    icon: 'codicon-robot',
    type: 'agent',
    data: { agent },
  };
}

export function forceRefreshAgents(): void {
  debugLog('[AgentProvider] Force refresh requested');
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0; // Reset retry count
  pendingWaiters.forEach(w => w.reject(new Error('Agents refresh requested')));
  pendingWaiters = [];
  requestRefresh();
}

export default agentProvider;
