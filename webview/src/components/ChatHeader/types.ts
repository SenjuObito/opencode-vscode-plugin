import type {
  FileChangeSummary,
  SubagentHistoryResponse,
  TaskEventMap,
  TodoItem,
} from '../../types';
import type { ContextInfo } from '../../hooks';
import type { TabScrollState } from '../../hooks/useScrollBehavior';
import type { PermissionMode, ReasoningEffort } from '../ChatInputBox/types';
import type { TabType } from '../StatusPanel/types';
import type { TabTranscript } from '../../store/tabTranscript';

export interface SessionTabData {
  id: string;
  sessionId: string | null;
  title: string;
  isCustomTitle?: boolean;
  isShared?: boolean;
  /**
   * This tab's transcript: the single owner of its messages.
   *
   * <p>The view renders `transcript.getSnapshot()`. Nothing else may hold a
   * second message array: a second copy is a copy that can drift.</p>
   */
  transcript: TabTranscript;
  /**
   * Host-owned outbox projection for this tab.
   *
   * <p>Only the host decides when an item is sent; this is a read-only view of
   * that state, keyed by tab so a background tab keeps its own queue.</p>
   */
  queue?: import('../../store/tabQueueStore').TabQueueSnapshot;
  /**
   * This tab is waiting for its transcript from the host.
   *
   * <p>History loading belongs to the tab that asked for it: the view shows the
   * indicator of the tab on screen, and a load that finishes in a background
   * tab must not touch the foreground one. It is tab state, not window state —
   * a window-wide flag is what let another tab's reset hide the indicator.</p>
   */
  historyLoading?: boolean;
  loading?: boolean;
  streamingActive?: boolean;
  isThinking?: boolean;
  status?: string;
  revertBoundaryId?: string | null;
  /** Background Agent task_* events owned by this tab. */
  taskEvents?: TaskEventMap;
  /** Authoritative todo snapshot owned by this tab. */
  sseTodos?: TodoItem[] | null;
  /** On-demand subagent transcripts owned by this tab. */
  subagentHistories?: Record<string, SubagentHistoryResponse>;
  /** Edits shown by this tab's StatusPanel. */
  filteredFileChanges?: FileChangeSummary[];
  /** Expanded state and selected page of this tab's StatusPanel. */
  statusPanelExpanded?: boolean;
  statusPanelTab?: TabType | null;
  permissionMode?: PermissionMode;
  selectedModel?: string;
  reasoningEffort?: ReasoningEffort;
  autoOpenFileEnabled?: boolean;
  contextInfo?: ContextInfo | null;
  activeFile?: string;
  selectedLines?: string;
  /** 未发送的附件（按 tab 保存，切 tab 时各自保留）。 */
  pendingPermissions?: any[];
  pendingQuestions?: any[];
  /** Plan approvals waiting for an answer in this tab. */
  pendingPlans?: any[];
  turnStartedAt?: number | null;
  usagePercentage?: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
  /**
   * How much of the transcript this tab has read back from the engine.
   *
   * <p>Owned by the host (`history.window`): the loaded page may contain zero
   * user turns, so the "load earlier" affordance must not be inferred from
   * `messages`.</p>
   */
  historyWindow?: import('../../store/historyWindow').HistoryWindowState | null;
  /** Per-tab reader position, restored when this tab is selected again. */
  scrollState?: TabScrollState;
}
