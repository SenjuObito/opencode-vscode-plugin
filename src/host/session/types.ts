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
	durationMs?: number;
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
	/**
	 * 发起请求的 tab。由 `SessionCallbackAdapter` 补上——它是唯一同时知道
	 * 「这条流属于哪个 tab、哪个 session」的地方，靠活跃会话去猜会错归属。
	 */
	tabId?: string;
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
	 * 子代理运行的权威终态（core 的 `[SUBAGENT_STATUS]`）。opencode v1 `task`
	 * 与 v2 `subagent`、同步与后台调用都走这一条事件；webview 只认它，不再
	 * 从 transcript 推断状态。
	 */
	onSubagentStatus?(jsonContent: string): void;
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
	/**
	 * 回合的权威终止（daemon 的 `[TURN_END] {sessionId, reason, turnId}`）。
	 *
	 * <p>与 `onStreamEnd()` 的区别：`onStreamEnd` 是「这一轮流式输出结束了」，
	 * `onTurnEnd` 是「这个回合彻底结束了」—— 它携带终止原因（idle / aborted /
	 * error / timeout / disconnected）与归属会话，是清 loading、终结工具卡片、
	 * 抑制迟到错误的唯一权威信号。idea 宿主同样以 `[TURN_END]` 为准。</p>
	 */
	onTurnEnd?(jsonContent: string): void;
	/**
	 * 服务端正在重试当前回合（限流／额度），并给出了原因。
	 *
	 * opencode 发 `session.status`（type=retry），带人话 message 和可点击的
	 * action（reason/title/message/label/link）。此前这条信号在宿主侧无人解析，
	 * 用户只能等到 180s 本地超时看到泛化文案，完全不知道是额度耗尽。
	 * payload 为 JSON 对象字符串。
	 */
	onRetryStatus?(payload: string): void;
}
