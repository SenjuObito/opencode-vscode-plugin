import type { DropdownItemData, PermissionMode } from '../types';
import i18n from '../../../i18n/config';
import { debugLog } from '../../../utils/debug.js';
import {
  getAgentSnapshot,
  requestAgents,
  selectPrimaryAgents,
  selectSubagents,
  waitForFirstAgents,
  type AgentInfo,
} from '../../../store/agentStore';

// ============================================================================
// Type Definitions
// ============================================================================

export type AgentItem = AgentInfo;

/**
 * 子代理提及项（@ 下拉中用于唤起子代理）。
 * name 即 opencode 的 agent 标识，插入输入框时写作 `@name`。
 */
export interface SubagentMentionItem {
  name: string;
  label: string;
  description?: string;
}

/**
 * 后端列表到达前用于渲染模式选择器的占位项。
 *
 * <p>只是显示占位，绝不写进 agent store：宿主是 agent 列表的唯一权威。</p>
 */
export const FALLBACK_PRIMARY_AGENTS: AgentItem[] = [
  { id: 'build', name: 'Build', mode: 'primary', description: '', prompt: '' },
  { id: 'plan', name: 'Plan', mode: 'primary', description: '', prompt: '' },
];

/** How long the async dropdowns wait for the host's first push. */
const FIRST_LOAD_TIMEOUT_MS = 1500;

// ============================================================================
// Synchronous selectors (mode selector / Shift+Tab / @ dropdown)
// ============================================================================

/**
 * Synchronously return primary agents (mode==='primary' && !hidden).
 *
 * <p>Until the host has pushed a list the built-in build/plan pair is rendered
 * as a placeholder; it is never persisted as data.</p>
 */
export function getPrimaryAgentsSync(query = '', includeFallback = true): AgentItem[] {
  const snapshot = getAgentSnapshot();
  const primaries = selectPrimaryAgents(snapshot.agents);
  const source = primaries.length > 0
    ? primaries
    : (includeFallback ? FALLBACK_PRIMARY_AGENTS : []);
  if (!query) return source;
  const q = query.toLowerCase();
  return source.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Next primary agent for Shift+Tab, cycling the host-pushed list.
 */
export function getNextPrimaryMode(current?: PermissionMode): string {
  if (getAgentSnapshot().agents.length === 0) {
    // Nothing has been pushed yet: ask once, but keep this press predictable.
    requestAgents();
  }
  const agents = getPrimaryAgentsSync();
  if (agents.length === 0) {
    return current === 'plan' ? 'build' : 'plan';
  }
  // Old persisted value 'default' is the legacy spelling of `build`.
  const currentId = current === 'default' ? 'build' : current;
  const index = currentId ? agents.findIndex(agent => agent.id === currentId) : -1;
  return agents[(index + 1) % agents.length].id;
}

/**
 * Synchronously return subagents (mode === 'subagent' && !hidden).
 * Used by the @ mention dropdown.
 */
export function getSubagentsSync(query = ''): AgentItem[] {
  const subs = selectSubagents(getAgentSnapshot().agents);
  if (!query) return subs;
  const q = query.toLowerCase();
  return subs.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.prompt?.toLowerCase().includes(q) ?? false) ||
    (a.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Ask the host for the catalogue if it has not pushed one yet.
 *
 * <p>Kept as the single "make sure the store is hydrated" entry point for the
 * preload call sites; there is no retry loop behind it.</p>
 */
export function ensureAgentsLoaded(): void {
  if (!getAgentSnapshot().loaded) {
    requestAgents();
  }
}

export function forceRefreshAgents(): void {
  debugLog('[AgentProvider] Force refresh requested');
  requestAgents();
}

// ============================================================================
// Async dropdown providers
// ============================================================================

export const CREATE_NEW_AGENT_ID = '__create_new__';
export const EMPTY_STATE_ID = '__empty_state__';

function filterAgents(agents: AgentItem[], query: string): AgentItem[] {
  if (!query) return agents;
  const lowerQuery = query.toLowerCase();
  return agents.filter(agent =>
    agent.name.toLowerCase().includes(lowerQuery) ||
    agent.prompt?.toLowerCase().includes(lowerQuery)
  );
}

export async function agentProvider(
  query: string,
  signal: AbortSignal
): Promise<AgentItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const snapshot = getAgentSnapshot();
  if (!snapshot.loaded) {
    requestAgents();
    await waitForFirstAgents(signal, FIRST_LOAD_TIMEOUT_MS);
  }

  // Create new agent item
  const createNewAgentItem: AgentItem = {
    id: CREATE_NEW_AGENT_ID,
    name: i18n.t('settings.agent.createAgent'),
    prompt: '',
  };

  const filtered = filterAgents(getAgentSnapshot().agents, query);
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
 * Provider for the @ mention dropdown: returns subagents only (mode === 'subagent').
 */
export async function subagentMentionProvider(
  query: string,
  signal: AbortSignal
): Promise<SubagentMentionItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const snapshot = getAgentSnapshot();
  if (!snapshot.loaded) {
    requestAgents();
    await waitForFirstAgents(signal, FIRST_LOAD_TIMEOUT_MS);
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
 * Inline SVG AI Agent / Sparkle icon (16x16, purple accent).
 * Represents autonomous subagents with a modern, crisp AI glyph.
 */
const SUBAGENT_SVG_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M7 1.5C7 4.54 4.54 7 1.5 7C4.54 7 7 9.46 7 12.5C7 9.46 9.46 7 12.5 7C9.46 7 7 4.54 7 1.5Z" fill="#9d7cd8"/>' +
  '<path d="M12 1.5C12 2.88 10.88 4 9.5 4C10.88 4 12 5.12 12 6.5C12 5.12 13.12 4 14.5 4C13.12 4 12 2.88 12 1.5Z" fill="#c0a7f5"/>' +
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

export default agentProvider;
