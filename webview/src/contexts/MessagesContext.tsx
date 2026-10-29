import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ClaudeMessage, SubagentHistoryResponse, TodoItem } from '../types';
import { getTabStore } from '../store/tabStore';
import { isTabTurnActive } from '../store/tabRuntime';
import type { CompactNoticeData } from '../components/ChatHeader/types';

export const DEFAULT_STATUS = 'ready';

const EMPTY_MESSAGES: ClaudeMessage[] = [];
const EMPTY_SUBAGENT_HISTORIES: Record<string, SubagentHistoryResponse> = {};

export interface MessagesContextValue {
  messages: ClaudeMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  subagentHistories: Record<string, SubagentHistoryResponse>;
  setSubagentHistories: React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>;
  status: string;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loadingStartTime: number | null;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  isThinking: boolean;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  streamingActive: boolean;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * True while the active tab still owns a running turn.
   *
   * <p>This is the shared busy derivation for the composer, the tab title and
   * the notice bar. `loading` and `streamingActive` are phases of the same turn,
   * so a consumer that needs "is the turn still running" must use this value
   * rather than one of the phases.</p>
   */
  turnActive: boolean;
  sessionLoading: boolean;
  setSessionLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /** Authoritative todo list from opencode's `todo.updated` SSE event. */
  sseTodos: TodoItem[] | null;
  setSseTodos: React.Dispatch<React.SetStateAction<TodoItem[] | null>>;
  isCompacting: boolean;
  setIsCompacting: React.Dispatch<React.SetStateAction<boolean>>;
  compactingStartTime: number | null;
  setCompactingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  /** Last compact result of this tab, shown until the next user message. */
  compactNotice: CompactNoticeData | null;
  setCompactNotice: React.Dispatch<React.SetStateAction<CompactNoticeData | null>>;
}

const MessagesContext = createContext<MessagesContextValue | null>(null);

function applyUpdater<T>(updater: React.SetStateAction<T>, current: T): T {
  return typeof updater === 'function'
    ? (updater as (previous: T) => T)(current)
    : updater;
}

/**
 * Provides messages flow state (messages, subagent histories, turn state).
 * Stage 1 of TASK-P1-01 (App.tsx God Component decomposition).
 *
 * <p>The active tab is the owner of the transcript and of the turn state. This
 * provider is a view over that owner: every getter reads the active tab and
 * every setter replaces the matching field on the active tab. Switching tabs
 * therefore switches the conversation and its loading/streaming indicators in
 * one step; there is no window-wide copy that a callback could update while the
 * title bar reads another copy.</p>
 *
 * task_events live in SubagentContext's TaskEventProvider, NOT here, so that
 * task_event updates do not invalidate this context's value and re-render
 * every consumer of it.
 */
export function MessagesProvider({ children }: { children: ReactNode }) {
  const tabStore = getTabStore();
  const activeTab = useSyncExternalStore(
    tabStore.subscribe,
    tabStore.getActiveTab,
    tabStore.getActiveTab,
  );

  const setMessages = useCallback<React.Dispatch<React.SetStateAction<ClaudeMessage[]>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        messages: applyUpdater(updater, tab.messages ?? EMPTY_MESSAGES),
      }));
    },
    [tabStore],
  );

  const setSubagentHistories = useCallback<React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        subagentHistories: applyUpdater(updater, tab.subagentHistories ?? EMPTY_SUBAGENT_HISTORIES),
      }));
    },
    [tabStore],
  );

  const setStatus = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        status: applyUpdater(updater, tab.status ?? DEFAULT_STATUS),
      }));
    },
    [tabStore],
  );

  const setLoading = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        loading: applyUpdater(updater, tab.loading ?? false),
      }));
    },
    [tabStore],
  );

  const setLoadingStartTime = useCallback<React.Dispatch<React.SetStateAction<number | null>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        turnStartedAt: applyUpdater(updater, tab.turnStartedAt ?? null),
      }));
    },
    [tabStore],
  );

  const setIsThinking = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        isThinking: applyUpdater(updater, tab.isThinking ?? false),
      }));
    },
    [tabStore],
  );

  const setStreamingActive = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        streamingActive: applyUpdater(updater, tab.streamingActive ?? false),
      }));
    },
    [tabStore],
  );

  const setSseTodos = useCallback<React.Dispatch<React.SetStateAction<TodoItem[] | null>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        sseTodos: applyUpdater(updater, tab.sseTodos ?? null),
      }));
    },
    [tabStore],
  );

  const setIsCompacting = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        isCompacting: applyUpdater(updater, tab.isCompacting ?? false),
      }));
    },
    [tabStore],
  );

  const setCompactingStartTime = useCallback<React.Dispatch<React.SetStateAction<number | null>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        compactingStartTime: applyUpdater(updater, tab.compactingStartTime ?? null),
      }));
    },
    [tabStore],
  );

  const setCompactNotice = useCallback<React.Dispatch<React.SetStateAction<CompactNoticeData | null>>>(
    (updater) => {
      tabStore.updateActiveTab((tab) => ({
        ...tab,
        compactNotice: applyUpdater(updater, tab.compactNotice ?? null),
      }));
    },
    [tabStore],
  );

  // A history download is a property of the viewport, not of a conversation:
  // it is true only while the current tab is restoring its transcript and must
  // not follow a tab switch.
  const [sessionLoading, setSessionLoading] = useState<boolean>(false);

  const messages = activeTab.messages ?? EMPTY_MESSAGES;
  const subagentHistories = activeTab.subagentHistories ?? EMPTY_SUBAGENT_HISTORIES;
  const status = activeTab.status ?? DEFAULT_STATUS;
  const loading = activeTab.loading ?? false;
  const loadingStartTime = activeTab.turnStartedAt ?? null;
  const isThinking = activeTab.isThinking ?? false;
  const streamingActive = activeTab.streamingActive ?? false;
  const turnActive = isTabTurnActive(activeTab);
  const sseTodos = activeTab.sseTodos ?? null;
  const isCompacting = activeTab.isCompacting ?? false;
  const compactingStartTime = activeTab.compactingStartTime ?? null;
  const compactNotice = activeTab.compactNotice ?? null;

  const value = useMemo<MessagesContextValue>(
    () => ({
      messages,
      setMessages,
      subagentHistories,
      setSubagentHistories,
      status,
      setStatus,
      loading,
      setLoading,
      loadingStartTime,
      setLoadingStartTime,
      isThinking,
      setIsThinking,
      streamingActive,
      setStreamingActive,
      turnActive,
      sessionLoading,
      setSessionLoading,
      sseTodos,
      setSseTodos,
      isCompacting,
      setIsCompacting,
      compactingStartTime,
      setCompactingStartTime,
      compactNotice,
      setCompactNotice,
    }),
    [
      messages,
      setMessages,
      subagentHistories,
      setSubagentHistories,
      status,
      setStatus,
      loading,
      setLoading,
      loadingStartTime,
      setLoadingStartTime,
      isThinking,
      setIsThinking,
      streamingActive,
      setStreamingActive,
      turnActive,
      sessionLoading,
      sseTodos,
      setSseTodos,
      isCompacting,
      setIsCompacting,
      compactingStartTime,
      setCompactingStartTime,
      compactNotice,
      setCompactNotice,
    ],
  );

  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/**
 * Read messages flow state. Must be used within MessagesProvider.
 *
 * Note: this hook returns the full context value. Components that re-render
 * frequently and only need a subset (e.g. only `messages`) should consider
 * splitting into focused selector hooks if profiling shows pressure.
 */
export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext);
  if (ctx === null) {
    throw new Error('useMessages must be used within a MessagesProvider');
  }
  return ctx;
}

export { MessagesContext };
