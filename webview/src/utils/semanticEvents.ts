/**
 * The semantic event catalog, webview side.
 *
 * <p>The host names an event semantically ({@code content.delta},
 * {@code message.snapshot}, {@code turn.ended}). This table is the webview's
 * half of the protocol contract: it records the legacy function name each
 * semantic type replaced, which is the name the Java catalog also carries.</p>
 *
 * <p>Routing itself is not done here. {@code hostEventRegistry} is the only
 * routing table, and {@code hostDispatcher} has no {@code window.<fn>}
 * fallback: an event whose semantic type has no registered handler waits in
 * the dispatcher queue and is dropped on timeout. This table exists so the two
 * sides cannot drift.</p>
 *
 * <p>Keep it in sync with {@code com.opencodebuddy.bridge.EventCatalog} — the
 * Java test {@code EventCatalogTest} asserts that both sides agree.</p>
 */
export const SEMANTIC_HANDLERS: Record<string, string> = {
  // ── lifecycle ──────────────────────────────────────────────────────
  'tab.resync': 'onTabResync',
  'session.bound': 'setSessionId',
  'session.loaded': 'historyLoadComplete',
  'session.cleared': 'clearMessages',
  'command.rejected': 'commandRejected',
  'attachment.failed': 'onAttachmentFailed',

  // ── turn & message ─────────────────────────────────────────────────
  'turn.started': 'onStreamStart',
  'turn.ended': 'onStreamEnd',
  'turn.settled': 'onTurnEnd',
  'turn.retry': 'updateRetryStatus',
  'turn.error': 'onTerminalError',
  'turn.heartbeat': 'onStreamingHeartbeat',
  'content.delta': 'onContentDelta',
  'thinking.delta': 'onThinkingDelta',
  'thinking.status': 'showThinkingStatus',
  'message.snapshot': 'updateMessages',
  'message.tail': 'updateMessageTail',
  'message.prepended': 'updateMessagesPrepend',
  'message.added': 'addUserMessage',
  'message.history': 'addHistoryMessage',
  'message.removed': 'onMessagesRemoved',
  'message.uuid.patched': 'patchMessageUuid',
  'message.block.reset': 'onBlockReset',

  // ── status & usage ─────────────────────────────────────────────────
  'status.updated': 'updateStatus',
  'session.loading': 'showLoading',
  'session.summary': 'showSummary',
  'usage.updated': 'onUsageUpdate',

  // ── tab & settings ─────────────────────────────────────────────────
  'tab.title.changed': 'updateSessionTitle',
  'settings.mode': 'onModeChanged',

  // ── prompts ────────────────────────────────────────────────────────
  'permission.requested': 'showPermissionDialog',
  'question.requested': 'showAskUserQuestionDialog',
  'question.answered': 'onQuestionAnswered',
  'question.invalidated': 'invalidateQuestionCard',
  'plan.requested': 'showPlanApprovalDialog',
  'prompt.closed': 'forceClosePermissionDialog',
  'prompt.question.closed': 'forceCloseAskUserQuestionDialog',
  'prompt.plan.closed': 'forceClosePlanApprovalDialog',

  // ── status panel ───────────────────────────────────────────────────
  'todos.updated': 'onTodoUpdated',
  'task.event': 'onTaskEvent',
  'subagent.status': 'onSubagentStatus',
  'subagent.history': 'onSubagentHistoryLoaded',
  'revert.changed': 'onRevertStateUpdate',

  // ── webview 回调事件（A3 全量迁移） ─────────────────────────────
  'agents.import.preview': 'agentImportPreviewResult',
  'agents.import.result': 'agentImportResult',
  'agents.operation': 'agentOperationResult',
  'tab.state': 'applyBackendTabState',
  'font.idea': 'applyIdeaFontConfig',
  'settings.pinned.models': 'applyPinnedModels',
  'settings.ui.preferences': 'applyUiPreferences',
  'mcp.toggled': 'mcpServerToggled',
  'node.process.killed': 'nodeProcessKillResult',
  'clipboard.read': 'onClipboardRead',
  'commands.deleted': 'onCommandsDeleted',
  'commands.listed': 'onCommandsList',
  'commands.detail': 'onCommandsRead',
  'commands.saved': 'onCommandsSaved',
  'session.compact.failed': 'onCompactError',
  'session.compact.done': 'onCompactSuccess',
  'context.usage.error': 'onContextUsageError',
  'clipboard.copied': 'onCopyToClipboardResult',
  'font.editor.received': 'onEditorFontConfigReceived',
  'font.ui.received': 'onUiFontConfigReceived',
  'font.code.received': 'onCodeFontConfigReceived',
  'font.ui.apply': 'applyUiFontConfig',
  'font.code.apply': 'applyCodeFontConfig',
  'language.apply': 'applyIdeaLanguageConfig',
  'settings.auto.open.file': 'updateAutoOpenFileEnabled',
  'settings.permission.timeout': 'updatePermissionDialogTimeout',
  'settings.send.shortcut': 'updateSendShortcut',
  'settings.streaming': 'updateStreamingEnabled',
  'settings.commit.generation': 'updateCommitGenerationEnabled',
  'settings.ai.title.generation': 'updateAiTitleGenerationEnabled',
  'settings.statusbar.widget': 'updateStatusBarWidgetEnabled',
  'settings.commit.prompt': 'updateCommitPrompt',
  'settings.project.commit.prompt': 'updateProjectCommitPrompt',
  'settings.prompt.enhancer': 'updatePromptEnhancerConfig',
  'settings.commit.ai': 'updateCommitAiConfig',
  'settings.task.completion': 'updateTaskCompletionNotificationEnabled',
  'settings.question.notification': 'updateAskUserQuestionNotificationEnabled',
  'settings.system.notification': 'updateSystemNotificationOnlyWhenUnfocused',
  'settings.question.sound': 'updateAskUserQuestionSoundNotificationEnabled',
  'files.listed': 'onFileListResult',
  'files.path.resolved': 'onFilePathResolved',
  'session.fork.bound': 'onForkBound',
  'session.fork.failed': 'onForkError',
  'session.fork.done': 'onForkSuccess',
  'theme.changed': 'onIdeThemeChanged',
  'theme.received': 'onIdeThemeReceived',
  'settings.mode.received': 'onModeReceived',
  'settings.model.confirmed': 'onModelConfirmed',
  'permission.denied': 'onPermissionDenied',
  'session.revert.failed': 'onRevertError',
  'session.hydrated': 'onSessionHydrated',
  'session.share.failed': 'onShareError',
  'session.share.done': 'onShareSuccess',
  'font.system.list': 'onSystemFontListReceived',
  'tab.activated': 'onTabActivated',
  'tokentracker.response': 'onTokenTrackerResponse',
  'files.undo.all': 'onUndoAllFileResult',
  'files.undo': 'onUndoFileResult',
  'session.unshare.failed': 'onUnshareError',
  'session.unshare.done': 'onUnshareSuccess',
  'skills.delete': 'skillDeleteResult',
  'skills.import': 'skillImportResult',
  'skills.toggle': 'skillToggleResult',
  'agents.updated': 'updateAgents',
  'cli.status': 'updateCliStatus',
  'copilot.import.preview': 'updateCopilotImportPreview',
  'daemon.status': 'updateDaemonStatus',
  'linkify.capabilities': 'updateLinkifyCapabilities',
  'mcp.marketplace.entries': 'updateMcpMarketplaceEntries',
  'mcp.marketplace.sources': 'updateMcpMarketplaceSources',
  'mcp.status': 'updateMcpServerStatus',
  'mcp.tools': 'updateMcpServerTools',
  'mcp.servers': 'updateMcpServers',
  'node.path': 'updateNodePath',
  'node.processes': 'updateNodeProcesses',
  'cli.path': 'updateOpencodeCliPath',
  'skills.updated': 'updateSkills',
  'slash.commands': 'updateSlashCommands',
  'settings.sound': 'updateSoundNotificationConfig',
  'project.working.directory': 'updateWorkingDirectory',
  'selection.info': 'addSelectionInfo',
  'selection.snippet': 'addCodeSnippet',
  'selection.clear': 'clearSelectionInfo',
  'message.error': 'addErrorMessage',
  'toast.shown': 'addToast',
  'toast.error': 'showToast',
  'toast.operation.error': 'showError',
  'toast.operation.success': 'showSuccess',
  'toast.operation.success.i18n': 'showSuccessI18n',
  'toast.switch.success': 'showSwitchSuccess',
  'context.usage.dialog': 'showContextUsageDialog',
  'cli.models': 'setCliModels',
  'history.data': 'setHistoryData',
  'chat.focus': 'focusChatInput',
  'files.path.from.ide': 'handleFilePathFromJava',
  'files.diff.result': 'handleDiffResult',
  'files.edits.remove': 'handleRemoveFileFromEdits',
  'tab.create.requested': 'createSessionTab',
};

/**
 * The legacy function name of a semantic type, or {@code null} when unknown.
 *
 * <p>For catalog cross-checks and diagnostics only: the dispatcher resolves
 * handlers through {@code hostEventRegistry}, never by this name.</p>
 */
export function handlerForSemanticType(type: string): string | null {
  if (!type) return null;
  return SEMANTIC_HANDLERS[type] ?? null;
}
