import type {
  ClaudeMessage,
  FileChangeSummary,
  SubagentHistoryResponse,
  TaskEventMap,
  TodoItem,
} from '../../types';
import type { ContextInfo } from '../../hooks';
import type { TabScrollState } from '../../hooks/useScrollBehavior';
import type { PermissionMode, ReasoningEffort } from '../ChatInputBox/types';
import type { TabType } from '../StatusPanel/types';
import type { TabMessageStore } from '../../store/tabMessageStore';

/**
 * The result of the last /compact on this tab.
 *
 * <p>It is stored on the tab rather than appended to the transcript: a
 * background compaction finishes while another tab is on screen, and the
 * history reload that follows would overwrite a message-only notice. It stays
 * until the user sends the next message, as the compact feedback describes a
 * context transition that the next prompt leaves behind.</p>
 */
export interface CompactNoticeData {
  status: 'success' | 'failure';
  detail?: string;
  at: number;
}

export interface SessionTabData {
  id: string;
  sessionId: string | null;
  title: string;
  isCustomTitle?: boolean;
  isShared?: boolean;
  messages: ClaudeMessage[];
  loading?: boolean;
  streamingActive?: boolean;
  isThinking?: boolean;
  status?: string;
  revertBoundaryId?: string | null;
  isCompacting?: boolean;
  compactingStartTime?: number | null;
  /** Compact result still waiting to be acknowledged by a user message. */
  compactNotice?: CompactNoticeData | null;
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
  pendingPermissions?: any[];
  pendingQuestions?: any[];
  /** Plan approvals waiting for an answer in this tab. */
  pendingPlans?: any[];
  turnStartedAt?: number | null;
  usagePercentage?: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
  messageBaseIndex?: number;
  opencodeListStart?: number;
  prependedHistoryMessageCount?: number;
  /** Per-tab reader position, restored when this tab is selected again. */
  scrollState?: TabScrollState;
  /**
   * The tab's transcript, reconciled by message id.
   *
   * <p>The store is shared by reference: the tab object is cloned on every
   * update, the store is not, so the transcript survives those clones and
   * keeps the identity of its messages.</p>
   */
  messageStore?: TabMessageStore;
}
