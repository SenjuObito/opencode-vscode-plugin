/**
 * Input box component type definitions
 * Feature: 004-refactor-input-box
 */
import type { DaemonIssue } from '../../hooks/providers/useUsageTracking';

// ============================================================
// Core Entity Types
// ============================================================

/**
 * File tag information for backend context injection (Codex mode)
 */
export interface FileTagInfo {
  /** Display path (as shown in tag) */
  displayPath: string;
  /** Absolute path (for file reading) */
  absolutePath: string;
}

/**
 * File attachment
 */
export interface Attachment {
  /** Unique identifier */
  id: string;
  /** Original filename */
  fileName: string;
  /** MIME type */
  mediaType: string;
  /** Base64 encoded content */
  data: string;
}

/**
 * Code snippet (from editor selection)
 */
export interface CodeSnippet {
  /** Unique identifier */
  id: string;
  /** File path (relative) */
  filePath: string;
  /** Start line number */
  startLine?: number;
  /** End line number */
  endLine?: number;
}

/**
 * Image media type constants
 */
export const IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * Check if attachment is an image
 */
export function isImageAttachment(attachment: Attachment): boolean {
  return IMAGE_MEDIA_TYPES.includes(attachment.mediaType as ImageMediaType);
}

// ============================================================
// Completion System Types
// ============================================================

/**
 * Completion item type
 */
export type CompletionType =
  | 'file'
  | 'directory'
  | 'command'
  | 'agent'
  | 'prompt'
  | 'terminal'
  | 'service'
  | 'info'
  | 'separator'
  | 'section-header';

/**
 * Dropdown menu item data
 */
export interface DropdownItemData {
  /** Unique identifier */
  id: string;
  /** Display text */
  label: string;
  /** Description text */
  description?: string;
  /** Icon class name */
  icon?: string;
  /** Item type */
  type: CompletionType;
  /** Whether selected (for selectors) */
  checked?: boolean;
  /** Associated data */
  data?: Record<string, unknown>;
}

/**
 * File item (returned from Java)
 */
export interface FileItem {
  /** Filename */
  name: string;
  /** Relative path */
  path: string;
  /** Absolute path (optional) */
  absolutePath?: string;
  /** Type */
  type: 'file' | 'directory' | 'terminal' | 'service';
  /** Extension */
  extension?: string;
}

/**
 * Command item (returned from Java)
 */
export interface CommandItem {
  /** Command identifier */
  id: string;
  /** Display name */
  label: string;
  /** Description */
  description?: string;
  /** Category */
  category?: string;
}

/**
 * Dropdown menu position
 */
export interface DropdownPosition {
  /** Top coordinate (px) */
  top: number;
  /** Left coordinate (px) */
  left: number;
  /** Width (px) */
  width: number;
  /** Height (px) */
  height: number;
}

/**
 * Trigger query information
 */
export interface TriggerQuery {
  /** Trigger symbol ('@' or '/' or '#' or '!') */
  trigger: string;
  /** Search keyword */
  query: string;
  /** Character offset position of trigger symbol */
  start: number;
  /** Character offset position of query end */
  end: number;
}

// ============================================================
// Mode and Model Types
// ============================================================

/**
 * Permission mode for conversations
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * Mode information
 */
export interface ModeInfo {
  id: PermissionMode;
  label: string;
  icon: string;
  disabled?: boolean;
  tooltip?: string;
  description?: string;
}

/**
 * Available permission modes
 */
export const AVAILABLE_MODES: ModeInfo[] = [
  {
    id: 'default',
    label: 'Default Mode',
    icon: 'codicon-comment-discussion',
    tooltip: 'Standard permission behavior',
    description: 'Requires manual confirmation for each operation',
  },
  {
    id: 'plan',
    label: 'Plan Mode',
    icon: 'codicon-tasklist',
    tooltip: 'Plan mode - read-only analysis',
    description: 'Read-only tools only, generates plan for user approval',
  },
  {
    id: 'acceptEdits',
    label: 'Agent Mode',
    icon: 'codicon-robot',
    tooltip: 'Auto-accept file edits',
    description: 'Auto-accept file creation/editing, fewer confirmations',
  },
  {
    id: 'bypassPermissions',
    label: 'Auto Mode',
    icon: 'codicon-zap',
    tooltip: 'Bypass all permission checks',
    description: 'Fully automated, bypasses all permission checks [use with caution]',
  },
];

/**
 * Set of valid permission mode IDs, derived from AVAILABLE_MODES.
 * Use isValidPermissionMode() for validation instead of inline checks.
 */
export const VALID_PERMISSION_MODE_IDS: ReadonlySet<string> = new Set(
  AVAILABLE_MODES.map((m) => m.id)
);

/**
 * OpenCode provider modes — map to opencode's built-in agents.
 * 'default' → build agent, 'plan' → plan agent (see host mapPermissionModeToAgent).
 */
export const OPENCODE_MODES: ModeInfo[] = [
  {
    id: 'default',
    label: 'Build',
    icon: 'codicon-tools',
    tooltip: 'OpenCode build agent',
    description: 'Full-access development agent (opencode default)',
  },
  {
    id: 'plan',
    label: 'Plan',
    icon: 'codicon-tasklist',
    tooltip: 'OpenCode plan agent',
    description: 'Read-only analysis, plans before writing code',
  },
];

/**
 * Check whether a string is a recognized PermissionMode.
 */
export function isValidPermissionMode(mode: string | undefined | null): mode is PermissionMode {
  return typeof mode === 'string' && VALID_PERMISSION_MODE_IDS.has(mode);
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  /** opencode model variants（推理力度档位 id 列表，来自 daemon 目录）。 */
  variants?: string[];
}

/**
 * Check if a model supports 1M context window.
 * All models support 1M except Haiku (matched by name substring).
 */
export function modelSupports1MContext(modelId: string | undefined | null): boolean {
  if (!modelId) {
    return false;
  }
  return !modelId.replace(/\[1m\]$/i, '').toLowerCase().includes('haiku');
}

/**
 * Check if a model ID already has [1m] suffix.
 */
export function has1MContextSuffix(modelId: string | undefined | null): boolean {
  if (!modelId) {
    return false;
  }
  return /\[1m\]$/i.test(modelId);
}

/**
 * Apply [1m] suffix to model ID if supported and enabled.
 * Returns the original model ID if the model doesn't support 1M context.
 */
export function apply1MContextSuffix(modelId: string, enabled: boolean): string {
  if (!enabled || !modelSupports1MContext(modelId)) {
    // Remove any existing [1m] suffix if disabled
    return modelId.replace(/\[1m\]$/i, '');
  }
  // Remove existing suffix first, then add new one
  const baseId = modelId.replace(/\[1m\]$/i, '');
  return `${baseId}[1m]`;
}

/**
 * Remove [1m] suffix from model ID for display/storage purposes.
 */
export function strip1MContextSuffix(modelId: string | undefined | null): string {
  if (!modelId) {
    return '';
  }
  return modelId.replace(/\[1m\]$/i, '');
}

/**
 * Fallback Claude model when nothing valid is saved. Must stay in sync with the
 * entry marked "Use the default model" in CLAUDE_MODELS — never derive this from
 * CLAUDE_MODELS[0], which is the newest tier and the most likely to be missing
 * from a user's API relay.
 */
export const DEFAULT_CLAUDE_MODEL_ID = 'claude-sonnet-4-7';

/**
 * Retired model IDs → their current-generation replacement. Lookup happens after
 * the [1m] suffix is stripped, so keys must be base IDs. Without an entry here a
 * saved retired model fails validation and silently resets to the fallback.
 */
const LEGACY_CLAUDE_MODEL_ID_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-4-7',
  'claude-opus-4-6': 'claude-opus-4-8',
};

export function normalizeClaudeModelId(modelId: string | undefined | null): string {
  if (!modelId) {
    return DEFAULT_CLAUDE_MODEL_ID;
  }
  // First strip any [1m] suffix
  const stripped = strip1MContextSuffix(modelId);
  return LEGACY_CLAUDE_MODEL_ID_ALIASES[stripped] ?? stripped;
}

/**
 * Claude model list (base IDs without [1m] suffix).
 * The 1M context suffix is applied dynamically via toggle.
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: 'Fable 5 · Most powerful · Mythos-class',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: 'Opus 5 · Latest Opus upgrade',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    description: 'Opus 4.8 · Previous Opus generation',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Sonnet 5 · Upgraded Sonnet model',
  },
  {
    id: 'claude-sonnet-4-7',
    label: 'Sonnet 4.7',
    description: 'Sonnet 4.7 · Use the default model',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

/**
 * Codex model list
 */
export const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Frontier model for complex professional work.',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'GPT-5.6 model that balances intelligence and cost.',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'GPT-5.6 model optimized for cost-sensitive workloads.',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Latest frontier model with stronger capabilities.',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Latest frontier model with enhanced capabilities.',
  },
];

/** OpenCode default: omit `--model` so CLI resolves its own default. */
export const OPENCODE_DEFAULT_MODEL_ID = 'opencode-default';

export const OPENCODE_MODELS: ModelInfo[] = [
  {
    id: OPENCODE_DEFAULT_MODEL_ID,
    label: 'OpenCode Default',
    description: 'Use OpenCode CLI default model',
  },
];

/**
 * Available models (backward compatibility)
 */
export const AVAILABLE_MODELS = CLAUDE_MODELS;

/**
 * AI provider information
 */
export interface ProviderInfo {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  /** When true, show a Beta badge and first-click notice dialog. */
  beta?: boolean;
}

/**
 * Available AI providers
 */
export const AVAILABLE_PROVIDERS: ProviderInfo[] = [
  { id: 'opencode', label: 'OpenCode', icon: 'codicon-terminal', enabled: true },
];

/**
 * Claude models that support adaptive thinking with effort parameter.
 * Based on: https://code.claude.com/docs/en/model-config#adjust-effort-level
 */
export const EFFORT_SUPPORTED_CLAUDE_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-5',
  'claude-sonnet-4-7',
  'claude-sonnet-4-6',
]);

/**
 * Claude models that additionally support the 'xhigh' effort level.
 */
export const XHIGH_EFFORT_CLAUDE_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
]);

/**
 * Claude models that support the 'max' effort level.
 */
export const MAX_EFFORT_CLAUDE_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-5',
  'claude-sonnet-4-7',
  'claude-sonnet-4-6',
]);

export function codexModelSupportsMaxEffort(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes('gpt-5.6');
}

/**
 * Reasoning Effort (thinking depth)
 * Controls the depth of reasoning for AI models
 * Claude API values: low, medium, high, xhigh, max
 * Codex API values: low, medium, high, xhigh; GPT-5.6 also supports max
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Codex execution speed mode.
 * Standard uses Codex defaults; Fast maps to service_tier=fast at send time.
 */
export type CodexFastMode = 'normal' | 'fast';

/**
 * Reasoning level information
 */
export interface ReasoningInfo {
  id: ReasoningEffort;
  label: string;
  icon: string;
  description?: string;
}

/**
 * Available reasoning levels
 */
export const REASONING_LEVELS: ReasoningInfo[] = [
  {
    id: 'low',
    label: 'Low',
    icon: 'codicon-circle-small',
    description: 'Quick responses with basic reasoning',
  },
  {
    id: 'medium',
    label: 'Medium',
    icon: 'codicon-circle-filled',
    description: 'Balanced thinking with moderate token savings',
  },
  {
    id: 'high',
    label: 'High',
    icon: 'codicon-circle-large-filled',
    description: 'Deep reasoning for complex tasks (default)',
  },
  {
    id: 'xhigh',
    label: 'XHigh',
    icon: 'codicon-flame',
    description: 'Extra deep reasoning for demanding tasks',
  },
  {
    id: 'max',
    label: 'Max',
    icon: 'codicon-rocket',
    description: 'Maximum reasoning depth',
  },
];

/**
 * Compute the visible reasoning levels for a provider/model combination.
 *
 * opencode 的推理力度 = model variants（按模型变化，见 docs/models#variants）。
 * 当动态目录携带所选模型的 `variants` 时只显示交集；否则回退到
 * cc-gui 的 per-provider/model 规则。
 */
export function getAvailableReasoningLevels(
  provider: string | undefined,
  selectedModel: string | undefined,
  modelVariants?: string[],
): ReasoningInfo[] {
  if (modelVariants && modelVariants.length > 0) {
    const known = REASONING_LEVELS.filter((level) => modelVariants.includes(level.id));
    if (known.length > 0) {
      return known;
    }
  }
  return REASONING_LEVELS.filter((level) => {
    if (provider === 'codex') {
      return level.id !== 'max' || (selectedModel !== undefined && codexModelSupportsMaxEffort(selectedModel));
    }
    if (provider !== 'claude') {
      return level.id !== 'max';
    }
    if (!selectedModel) {
      return true;
    }
    if (level.id === 'xhigh') {
      return XHIGH_EFFORT_CLAUDE_MODELS.has(selectedModel);
    }
    if (level.id === 'max') {
      return MAX_EFFORT_CLAUDE_MODELS.has(selectedModel);
    }
    return true;
  });
}

// ============================================================
// Usage Types
// ============================================================

/**
 * Usage information
 */
export interface UsageInfo {
  /** Usage percentage (0-100) */
  percentage: number;
  /** Used amount */
  used?: number;
  /** Total amount */
  total?: number;
}

// ============================================================
// Component Ref Handle Types
// ============================================================

/**
 * ChatInputBox imperative API
 * Used for performance optimization - uncontrolled mode with imperative access
 */
export interface ChatInputBoxHandle {
  /** Get current input text content */
  getValue: () => string;
  /** Set input text content */
  setValue: (value: string) => void;
  /** Focus the input element */
  focus: () => void;
  /** Clear input content */
  clear: () => void;
  /** Check if input has content */
  hasContent: () => boolean;
  /** Get file tags from input (for Codex context injection) */
  getFileTags: () => FileTagInfo[];
}

// ============================================================
// Component Props Types
// ============================================================

/**
 * ChatInputBox component props
 */
export interface ChatInputBoxProps {
  /** Whether loading */
  isLoading?: boolean;
  /** Current model */
  selectedModel?: string;
  /** Current permission mode */
  permissionMode?: PermissionMode;
  /** Current provider */
  currentProvider?: string;
  /** Usage percentage */
  usagePercentage?: number;
  /** Used context tokens */
  usageUsedTokens?: number;
  /** Maximum context tokens */
  usageMaxTokens?: number;
  /** Whether to show usage */
  showUsage?: boolean;
  /** Whether always thinking is enabled */
  alwaysThinkingEnabled?: boolean;
  /** Attachment list */
  attachments?: Attachment[];
  /** Placeholder text */
  placeholder?: string;
  /** Whether disabled */
  disabled?: boolean;
  /** Controlled mode: input content */
  value?: string;

  /** Current active file */
  activeFile?: string;
  /** Selected lines info (e.g., "L10-20") */
  selectedLines?: string;

  /** Clear context callback */
  onClearContext?: () => void;
  /** Remove code snippet callback */
  onRemoveCodeSnippet?: (id: string) => void;

  // Event callbacks
  /** Submit message */
  onSubmit?: (content: string, attachments?: Attachment[]) => void;
  /** Stop generation */
  onStop?: () => void;
  /** Input change */
  onInput?: (content: string) => void;
  /** Add attachment */
  onAddAttachment?: (files: FileList) => void;
  /** Remove attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Switch mode */
  onModeSelect?: (mode: PermissionMode) => void;
  /** Switch model */
  onModelSelect?: (modelId: string) => void;
  /** Switch provider */
  onProviderSelect?: (providerId: string) => void;
  /** Current reasoning effort */
  reasoningEffort?: ReasoningEffort;
  /** Switch reasoning effort callback */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** Codex speed mode */
  codexFastMode?: CodexFastMode;
  /** Switch Codex speed mode callback */
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  /** Toggle thinking mode */
  onToggleThinking?: (enabled: boolean) => void;

  /** Send shortcut setting: 'enter' = Enter sends | 'cmdEnter' = Cmd/Ctrl+Enter sends */
  sendShortcut?: 'enter' | 'cmdEnter';

  /** Open model settings (navigate to provider management to add models) */
  onOpenModelSettings?: () => void;


  /** Whether StatusPanel is expanded */
  statusPanelExpanded?: boolean;
  /** Toggle StatusPanel expand/collapse */
  onToggleStatusPanel?: () => void;

  /** SDK installed status (disable input when not installed) */
  sdkInstalled?: boolean;
  /** Daemon status loaded */
  daemonStatusLoaded?: boolean;
  /** Concrete reason the daemon/opencode serve failed to start (null when healthy) */
  daemonIssue?: DaemonIssue | null;
  /** Retry daemon status check callback */
  onRetryDaemonStatus?: () => void;
  /** Session loading indicator (transitioning between history sessions) */
  sessionLoading?: boolean;
  /** Show toast message */
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;

  /** Message queue items */
  messageQueue?: QueuedMessage[];
  /** Remove message from queue callback */
  onRemoveFromQueue?: (id: string) => void;

  /** Whether auto open file is enabled */
  autoOpenFileEnabled?: boolean;
  /** Toggle auto open file enabled */
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
  /** Whether long context (1M) is enabled */
  longContextEnabled?: boolean;
  /** Toggle long context callback */
  onLongContextChange?: (enabled: boolean) => void;
  /** Callback to trigger compact command */
  onCompactClick?: () => void;
}

/**
 * ButtonArea component props
 */
export interface ButtonAreaProps {
  /** Whether submit disabled */
  disabled?: boolean;
  /** Whether has input content */
  hasInputContent?: boolean;
  /** Whether in conversation */
  isLoading?: boolean;
  /** Current model */
  selectedModel?: string;
  /** Current mode */
  permissionMode?: PermissionMode;
  /** Current provider */
  currentProvider?: string;
  /** Current reasoning effort */
  reasoningEffort?: ReasoningEffort;
  /** Codex speed mode */
  codexFastMode?: CodexFastMode;

  // Event callbacks
  onSubmit?: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  /** Switch reasoning effort callback */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** Switch Codex speed mode callback */
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  /** Whether always thinking enabled */
  alwaysThinkingEnabled?: boolean;
  /** Toggle thinking mode */
  onToggleThinking?: (enabled: boolean) => void;
  /** Navigate to model management to add models */
  onAddModel?: () => void;
  /** Whether long context (1M) is enabled */
  longContextEnabled?: boolean;
  /** Toggle long context callback */
  onLongContextChange?: (enabled: boolean) => void;
}

/**
 * Dropdown component props
 */
export interface DropdownProps {
  /** Whether visible */
  isVisible: boolean;
  /** Position information */
  position: DropdownPosition | null;
  /** Width */
  width?: number;
  /** Y offset */
  offsetY?: number;
  /** X offset */
  offsetX?: number;
  /** Selected index */
  selectedIndex?: number;
  /** Close callback */
  onClose?: () => void;
  /** Children */
  children: React.ReactNode;
}

/**
 * TokenIndicator component props
 */
export interface TokenIndicatorProps {
  /** Percentage (0-100) */
  percentage: number;
  /** Size */
  size?: number;
  /** Used context tokens */
  usedTokens?: number;
  /** Maximum context tokens */
  maxTokens?: number;
}

/**
 * AttachmentList component props
 */
export interface AttachmentListProps {
  /** Attachment list */
  attachments: Attachment[];
  /** Remove attachment callback */
  onRemove?: (id: string) => void;
  /** Preview image callback */
  onPreview?: (attachment: Attachment) => void;
}

/**
 * DropdownItem component props
 */
export interface DropdownItemProps {
  /** Item data */
  item: DropdownItemData;
  /** Whether highlighted */
  isActive?: boolean;
  /** Click callback */
  onClick?: () => void;
  /** Mouse enter callback */
  onMouseEnter?: () => void;
}

// ============================================================
// Message Queue Types
// ============================================================

/**
 * Queued message item
 * When AI is processing (loading), new messages are queued here
 */
export interface QueuedMessage {
  /** Unique identifier */
  id: string;
  /** Message content */
  content: string;
  /** Attachments (optional) */
  attachments?: Attachment[];
  /** Timestamp when queued */
  queuedAt: number;
}
