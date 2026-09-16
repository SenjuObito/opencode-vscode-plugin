/**
 * Core session types — port of cc-gui `session/ClaudeSession.java` Message +
 * SessionCallback, plus `session/SessionState.java` whitelists.
 */

/** One message in the conversation. `raw` is the full SDK JSON (blocks etc.). */
export enum MessageType {
	USER = 'user',
	ASSISTANT = 'assistant',
	SYSTEM = 'system',
	ERROR = 'error',
}

export interface ChatMessage {
	type: MessageType;
	content: string;
	timestamp: number;
	raw?: unknown; // raw SDK JSON object (message blocks, usage, …)
}

/** Minimal permission request (Phase 4 wires the full dialog + reply path). */
export interface PermissionRequest {
	type: string;
	toolUseId: string;
	toolName: string;
	description: string;
	/** 工具名（permission 事件 `action` 字段），与 toolName 同义但来源不同。 */
	tool?: string;
	/** 工具入参对象（权限卡片展示 command 内容）。 */
	inputs?: Record<string, unknown>;
	decision?: 'allow' | 'deny';
	sessionId?: string;
	/** opencode 侧请求 id（permission/question 事件 `data.id`），用于回传。 */
	requestId?: string;
	/** 对应会话的工作区目录（用于服务端多实例寻址）。 */
	directory?: string;
	/** 提问弹层所需的原始 questions（type === 'question' 时）。 */
	questions?: Array<Record<string, unknown>>;
}

export interface SessionCallback {
	onMessageUpdate(messages: ChatMessage[]): void;
	onStateChange(busy: boolean, loading: boolean, error: string | null): void;
	onStatusMessage?(message: string): void;
	onSessionIdReceived(sessionId: string): void;
	onPermissionRequested?(request: PermissionRequest): void;
	/** 服务端已答复/取消未决 prompt。content 为 JSON（question: {requestId}；permission: {permissionId}）。 */
	onPermissionClosed?(kind: 'question' | 'permission', content: string): void;
	onThinkingStatusChanged(isThinking: boolean): void;
	onSlashCommandsReceived?(commands: string[]): void;
	onNodeLog?(log: string): void;
	onSummaryReceived?(summary: string): void;
	onStreamStart(): void;
	onStreamEnd(): void;
	onContentDelta(delta: string): void;
	onThinkingDelta(delta: string): void;
	onBlockReset(): void;
	onUsageUpdate(usedTokens: number, maxTokens: number): void;
	onUserMessageUuidPatched(content: string, uuid: string): void;
	onTaskEvent?(eventJson: string): void;
	/**
	 * revert 指针变化。messageId 是服务端指针指向的用户消息 id（无 revert 时为
	 * null），webview 据此把转录切在正确的边界上。
	 */
	onRevertStateUpdate?(hasRevert: boolean, messageId?: string | null): void;
	/**
	 * 服务端权威删除了一批消息（opencode 在下一次 prompt 时执行 revert cleanup，
	 * 逐条广播 message.removed）。webview 必须先把自己列表里的这些消息剔除，
	 * 随后的 updateMessages 快照才会等长地覆盖 —— 否则收缩保护会把刚删掉的
	 * 消息当成「暂时收缩」抢救回来。
	 */
	onMessagesRemoved?(messageIds: string[]): void;
	onTodoUpdated?(payload: string): void;
	onSessionTitleReceived?(sessionId: string, title: string): void;
}
