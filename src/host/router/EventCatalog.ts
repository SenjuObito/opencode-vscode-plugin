/**
 * EventCatalog — Semantic event catalog for host -> webview events.
 * Mirrors `com.opencodebuddy.bridge.EventCatalog` in opencode-idea-gui
 * with additions for VS Code multi-view synchronization.
 */

const FUNCTION_BY_TYPE: Record<string, string> = {
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
	'history.window': 'onHistoryWindowInfo',
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
	/** Projection of one tab's host-owned message queue. */
	'tab.queue.changed': 'onTabQueueChanged',

	// ── webview 回调事件 ──────────────────────────────────────────────
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
	'session.compact.started': 'onCompactStarted',
	'session.compact.delta': 'onCompactDelta',
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

	// ── VS Code 多视图新增事件（D1 架构需要） ─────────────────────────
	'tab.created': 'onTabCreated',
	'tab.closed': 'onTabClosed',
	'view.ready': 'onViewReady',
	'view.focus': 'onViewFocus',
	'view.navigate': 'onViewNavigate',
	'prompt.host.changed': 'onPromptHostChanged',
	'tab.draft.changed': 'onTabDraftChanged',
	'tab.reordered': 'onTabReordered',
};

const TYPE_BY_FUNCTION: Record<string, string> = {};
for (const [type, fn] of Object.entries(FUNCTION_BY_TYPE)) {
	if (!TYPE_BY_FUNCTION[fn]) {
		TYPE_BY_FUNCTION[fn] = type;
	}
}

export class EventCatalog {
	private constructor() {}

	/**
	 * 将旧版 JavaScript 函数名或带 window. 前缀的名称解析为语义类型。
	 */
	static semanticType(functionName: string | null | undefined): string {
		if (!functionName || typeof functionName !== 'string') {
			return '';
		}
		const bare = functionName.startsWith('window.')
			? functionName.slice('window.'.length)
			: functionName;
		return TYPE_BY_FUNCTION[bare] || bare;
	}

	/**
	 * 获取语义类型对应的旧版 JavaScript 函数名。
	 */
	static functionName(semanticType: string | null | undefined): string | null {
		if (!semanticType) {
			return null;
		}
		return FUNCTION_BY_TYPE[semanticType] || null;
	}

	/**
	 * 获取全部注册的事件目录映射副本。
	 */
	static catalog(): Readonly<Record<string, string>> {
		return { ...FUNCTION_BY_TYPE };
	}

	/**
	 * 获取已注册事件总数。
	 */
	static size(): number {
		return Object.keys(FUNCTION_BY_TYPE).length;
	}

	/**
	 * 检查语义事件是否已在目录中定义。
	 */
	static hasType(semanticType: string): boolean {
		return Object.prototype.hasOwnProperty.call(FUNCTION_BY_TYPE, semanticType);
	}
}
