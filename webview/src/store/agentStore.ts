/**
 * Agent catalogue snapshot (opencode primary agents / subagents).
 *
 * <p>The host owns this data: it fetches the engine's agent list (and pushes it
 * after `opencode serve` becomes ready, on webview reload, and after config
 * changes). The webview keeps the last pushed list so the synchronous consumers
 * (mode selector, {@code @} dropdown, Shift+Tab) can read it, but it does not
 * infer races, retry on a timer, or fall back to a fabricated list.</p>
 *
 * <p>This mirrors the provider-catalogue pattern in `useCliModels`: one
 * module-level snapshot, one host-event registration, `useSyncExternalStore`
 * for React consumers.</p>
 */
import { useSyncExternalStore } from 'react';
import { sendWindowCommand } from '../utils/bridge';
import { registerHostEvents } from '../utils/hostEventRegistry';
import { readJson } from '../utils/hostEventTypes';

export interface AgentInfo {
  id: string;
  name: string;
  prompt?: string;
  /** opencode agent mode: 'primary' = 主代理, 'subagent' = 子代理, 'all' = 聚合 */
  mode?: 'primary' | 'subagent' | 'all' | string;
  /** 隐藏的系统代理（compaction/title/summary）不对外暴露 */
  hidden?: boolean;
  description?: string;
  /** Agent-declared accent colour (`#rrggbb`) from the engine, if any. */
  color?: string;
}

export interface AgentState {
  agents: AgentInfo[];
  /** True once the host has answered at least once (an empty answer included). */
  loaded: boolean;
}

let state: AgentState = { agents: [], loaded: false };
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others.
    }
  });
}

function publish(agents: AgentInfo[]): void {
  state = { agents, loaded: true };
  notify();
}

function normalizeAgent(value: Partial<AgentInfo>): AgentInfo {
  const name = value.name || value.id || '';
  return {
    id: value.id || name,
    name,
    prompt: value.prompt,
    mode: value.mode,
    hidden: value.hidden,
    description: value.description,
    color: value.color,
  };
}

/**
 * Apply one `agents.updated` payload.
 *
 * <p>Named events carry the list in `data`; older callers passed the JSON string
 * directly. Both shapes are accepted and a malformed payload is ignored (the
 * last good snapshot stays).</p>
 */
export function handleAgentsUpdated(payload: unknown): void {
  const raw = typeof payload === 'string'
    ? payload
    : (payload && typeof payload === 'object' && 'data' in payload
      ? (payload as { data?: unknown }).data
      : payload);

  const parsed = readJson<unknown>(raw);
  if (!Array.isArray(parsed)) return;

  publish(
    parsed
      .filter((agent): agent is Partial<AgentInfo> => !!agent && typeof agent === 'object')
      .map(normalizeAgent)
      .filter((agent) => agent.name !== ''),
  );
}

/**
 * Ask the host for the catalogue.
 *
 * <p>No retry and no timer: the host pushes the list again when the engine
 * becomes ready, so a request that lands too early is harmless.</p>
 */
export function requestAgents(): void {
  // Keep the registration alive across a test reset / settings teardown that
  // clears the registry.
  registerHostEvents({ 'agents.updated': handleAgentsUpdated });
  sendWindowCommand('agents.list');
}

export function getAgentSnapshot(): AgentState {
  return state;
}

export function subscribeAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of the host-pushed catalogue. */
export function useAgents(): AgentState {
  return useSyncExternalStore(subscribeAgents, getAgentSnapshot);
}

/**
 * Wait for the first host answer, for the async dropdown providers only.
 *
 * <p>This waits for the event; it never asks again. A timeout resolves with the
 * current snapshot so the dropdown can render instead of hanging.</p>
 */
export function waitForFirstAgents(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (state.loaded) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe?.();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    timer = window.setTimeout(finish, timeoutMs);
    unsubscribe = subscribeAgents(() => {
      if (state.loaded) finish();
    });
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function selectPrimaryAgents(agents: AgentInfo[]): AgentInfo[] {
  // opencode agents may omit `mode` for legacy/default primary agents; treat
  // missing or 'all' as primary unless explicitly hidden or a subagent.
  return agents.filter(
    (agent) => !agent.hidden
      && (agent.mode === 'primary' || agent.mode === 'all' || agent.mode == null),
  );
}

export function selectSubagents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.mode === 'subagent' && !agent.hidden);
}

/** Test-only: drop the snapshot and re-register the host event. */
export function __resetAgentStoreForTests(): void {
  state = { agents: [], loaded: false };
  listeners.clear();
  registerHostEvents({ 'agents.updated': handleAgentsUpdated });
}

if (typeof window !== 'undefined') {
  registerHostEvents({ 'agents.updated': handleAgentsUpdated });
}
