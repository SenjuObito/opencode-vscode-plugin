/**
 * Session state management — port of cc-gui `session/SessionState.java`.
 * Holds all state for one conversation (opencode only: provider is fixed).
 */
import { randomUUID } from 'crypto';
import { ChatMessage, MessageType } from './types';
import { truncateMessageRawForState } from '../util/MessageJsonConverter';

/** Canonical permission-mode validator (opencode primary agent ids).
 * Any non-empty string is accepted; the legacy 'default' value is mapped to
 * 'build' for backward compatibility.
 */
export function isValidPermissionMode(mode: string | null | undefined): boolean {
	return mode != null && mode.trim().length > 0;
}

export function normalizePermissionMode(mode: string | null | undefined): string | null {
	if (mode == null) {
		return null;
	}
	const trimmed = mode.trim();
	if (trimmed.length === 0) {
		return null;
	}
	// Backward compatibility: old UI value 'default' maps to opencode 'build'.
	return trimmed === 'default' ? 'build' : trimmed;
}

/**
 * 合法的推理力度档位。
 *
 * `default` **必须**在这个白名单里：它不是一个真实档位，而是「本次不发 variant，
 * 让 opencode 用模型目录自己的设置」。把它漏掉的话 `setReasoningEffort` 会静默
 * 丢弃它 —— 状态里继续留着上一档（例如 low），UI 显示 Default 却照旧把旧的
 * low 发给服务端。`normalizeRequestedReasoningEffort` 负责在发送前把它变成 null。
 */
const VALID_REASONING_EFFORTS = new Set(['default', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isValidReasoningEffort(effort: string | null | undefined): boolean {
	return effort != null && VALID_REASONING_EFFORTS.has(effort.trim());
}

/**
 * 把「UI 选择的档位」归一成「要发给服务端的 variant」。
 *
 * <p>`default` 表示不发 variant（daemon 侧对 'default' 也做了同样的归一，这里
 * 提前归一可以让 `opencode.send` 的参数更干净，两者语义一致）。</p>
 */
export function normalizeRequestedReasoningEffort(
	effort: string | null | undefined,
): string | undefined {
	if (effort == null) {
		return undefined;
	}
	const trimmed = effort.trim();
	if (trimmed === '' || trimmed === 'default') {
		return undefined;
	}
	return trimmed;
}

export class SessionState {
	// ── 会话标识 ──
	private sessionId: string | null = null;
	private channelId: string | null = null;
	private runtimeSessionEpoch: string = randomUUID();

	// ── 会话状态 ──
	private busy = false;
	private loading = false;
	private error: string | null = null;
	private activeTurnStartTime: number | null = null;

	// ── 消息历史 ──
	private readonly messages: ChatMessage[] = [];

	// ── 会话元数据 ──
	private summary: string | null = null;
	private lastModifiedTime = Date.now();
	private cwd: string | null = null;

	// ── 配置（opencc 固定 provider='opencode'）──
	private permissionMode = 'default';
	private model: string | null = null; // null = 用 opencode 默认模型
	private readonly provider = 'opencode';
	private reasoningEffort: string | null = null;
	private slashCommands: string[] = [];
	
	// ── Revert state ──
	private revertState: { messageID: string; partID?: string; snapshot?: string; diff?: string } | null = null;

	// Getters
	getSessionId(): string | null {
		return this.sessionId;
	}
	getChannelId(): string | null {
		return this.channelId;
	}
	isBusy(): boolean {
		return this.busy;
	}
	isLoading(): boolean {
		return this.loading;
	}
	getError(): string | null {
		return this.error;
	}
	getMessages(): ChatMessage[] {
		return [...this.messages];
	}
	getMessagesReference(): ChatMessage[] {
		return this.messages;
	}
	getSummary(): string | null {
		return this.summary;
	}
	getLastModifiedTime(): number {
		return this.lastModifiedTime;
	}
	getCwd(): string | null {
		return this.cwd;
	}
	getPermissionMode(): string {
		return this.permissionMode;
	}
	getModel(): string | null {
		return this.model;
	}
	getProvider(): string {
		return this.provider;
	}
	getReasoningEffort(): string | null {
		return this.reasoningEffort;
	}
	getRuntimeSessionEpoch(): string {
		return this.runtimeSessionEpoch;
	}
	getSlashCommands(): string[] {
		return [...this.slashCommands];
	}
	getRevertState(): { messageID: string; partID?: string; snapshot?: string; diff?: string } | null {
		return this.revertState;
	}

	private sessionIdListeners: Array<(id: string) => void> = [];

	onSessionIdAssigned(listener: (id: string) => void): () => void {
		this.sessionIdListeners.push(listener);
		return () => {
			this.sessionIdListeners = this.sessionIdListeners.filter((l) => l !== listener);
		};
	}

	// Setters
	setSessionId(sessionId: string | null): void {
		this.sessionId = sessionId;
		if (sessionId) {
			for (const listener of this.sessionIdListeners) {
				try {
					listener(sessionId);
				} catch {
					/* ignore */
				}
			}
		}
	}
	setChannelId(channelId: string | null): void {
		this.channelId = channelId;
	}
	setBusy(busy: boolean): void {
		this.busy = busy;
	}
	getActiveTurnStartTime(): number | null {
		return this.activeTurnStartTime;
	}
	setActiveTurnStartTime(time: number | null): void {
		this.activeTurnStartTime = time;
	}
	setLoading(loading: boolean): void {
		this.loading = loading;
		if (loading) {
			if (this.activeTurnStartTime === null) {
				this.activeTurnStartTime = Date.now();
			}
		} else {
			this.activeTurnStartTime = null;
		}
	}
	setError(error: string | null): void {
		this.error = error;
	}
	setSummary(summary: string | null): void {
		this.summary = summary;
	}
	setLastModifiedTime(time: number): void {
		this.lastModifiedTime = time;
	}
	setCwd(cwd: string | null): void {
		this.cwd = cwd;
	}
	setPermissionMode(mode: string): void {
		const normalized = normalizePermissionMode(mode);
		if (normalized == null) {
			return; // 拒绝空字符串
		}
		this.permissionMode = normalized;
	}
	setModel(model: string | null): void {
		this.model = model;
	}
	setReasoningEffort(effort: string | null | undefined): void {
		if (effort == null || effort.trim() === '') {
			this.reasoningEffort = null;
			return;
		}
		const trimmed = effort.trim();
		if (!isValidReasoningEffort(trimmed)) {
			return;
		}
		this.reasoningEffort = trimmed;
	}
	setRuntimeSessionEpoch(epoch: string | null | undefined): void {
		this.runtimeSessionEpoch = epoch == null || epoch.trim() === '' ? randomUUID() : epoch;
	}
	rotateRuntimeSessionEpoch(): string {
		this.runtimeSessionEpoch = randomUUID();
		return this.runtimeSessionEpoch;
	}
	setSlashCommands(commands: string[]): void {
		this.slashCommands = [...commands];
	}
	setRevertState(state: { messageID: string; partID?: string; snapshot?: string; diff?: string } | null): void {
		this.revertState = state;
	}

	// ── 消息操作 ──
	addMessage(message: ChatMessage): void {
		// 准入截断：raw 里的超长字符串块（工具输出/长文本）进入长期驻留的
		// state 前截断到 32K/块，防超大 raw 撑爆内存。
		this.messages.push(truncateMessageRawForState(message));
	}
	clearMessages(): void {
		this.messages.length = 0;
	}

	/**
	 * 把更早的一页历史前插到转录开头（磁盘分页）。
	 *
	 * <p>与 {@link addMessage} 走同一套 raw 准入截断：被前插的页同样会长期
	 * 驻留在 state 里，不能成为内存放大的旁路。</p>
	 *
	 * @returns 实际前插的条目（raw 已按准入规则截断，可安全推给 webview）
	 */
	prependMessages(messages: ChatMessage[]): ChatMessage[] {
		if (messages.length === 0) {
			return [];
		}
		const stored = messages.map(truncateMessageRawForState);
		this.messages.unshift(...stored);
		return stored;
	}

	/**
	 * 当前正在进行的压缩记录（最多一条）。
	 *
	 * <p>引擎在同一会话里串行执行压缩，所以 `running` 期间再次收到 started
	 * 只能理解为同一次压缩的第二个信号，而不是第二次压缩。</p>
	 */
	findActiveCompaction(): ChatMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.type === MessageType.COMPACTION && message.compaction?.status === 'in_progress') {
				return message;
			}
		}
		return undefined;
	}

	hasActiveCompaction(): boolean {
		return this.findActiveCompaction() != null;
	}

	/** 按引擎消息 id 找一条压缩记录（历史行与实时卡共用身份）。 */
	findCompactionById(id: string | null | undefined): ChatMessage | undefined {
		if (!id) {
			return undefined;
		}
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.type !== MessageType.COMPACTION) {
				continue;
			}
			const raw = message.raw as Record<string, unknown> | undefined;
			if (raw && (raw.id === id || raw.uuid === id)) {
				return message;
			}
		}
		return undefined;
	}

	/**
	 * 开始（或继续）一次压缩。
	 *
	 * <p>只创建，不追加第二条：已有 running 记录时只补齐 reason / id。
	 * 返回的记录位置固定，终态不会把它移动到列表末尾。</p>
	 */
	beginCompaction(reason: string, engineId?: string | null): ChatMessage {
		const active = this.findActiveCompaction();
		if (active) {
			if (active.compaction) {
				// The first trigger owns the wording: a manual /compact creates
				// the record before the engine's own (often `auto`-shaped) start.
				active.compaction = {
					...active.compaction,
					reason: active.compaction.reason || reason,
				};
			}
			if (engineId) {
				stampCompactionId(active, engineId, false);
			}
			return active;
		}

		const startedAt = Date.now();
		const message: ChatMessage = {
			type: MessageType.COMPACTION,
			content: '',
			timestamp: startedAt,
			raw: { type: 'compaction' },
			compaction: {
				status: 'in_progress',
				reason: reason || 'auto',
				startedAt,
			},
		};
		if (engineId) {
			stampCompactionId(message, engineId, false);
		}
		this.messages.push(message);
		return message;
	}

	/** 压缩摘要增量（仅用于 running 记录；终态会带完整 summary）。 */
	applyCompactionSummary(text: string): void {
		if (!text) {
			return;
		}
		const active = this.findActiveCompaction();
		if (!active) {
			return;
		}
		active.content = (active.content ?? '') + text;
	}

	/**
	 * 结束一次压缩。
	 *
	 * <p>终态只更新，不新建：先找 running，再按引擎 id 找；都找不到才补建
	 * （引擎在漏发 started 时也会补一条 completed/failed）。因此重复的、
	 * 迟到的终态事件都不会多出一条记录。</p>
	 */
	finishCompaction(
		status: 'completed' | 'failed',
		options: {
			id?: string | null;
			summary?: string;
			error?: string;
			tokens?: Record<string, unknown>;
			reason?: string;
			startedAt?: number;
			completedAt?: number;
		} = {},
	): ChatMessage {
		const { id, summary, error, tokens, reason, startedAt } = options;
		let target = this.findActiveCompaction() ?? this.findCompactionById(id);
		if (!target) {
			const createdAt = typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now();
			target = {
				type: MessageType.COMPACTION,
				content: '',
				timestamp: createdAt,
				raw: { type: 'compaction' },
				compaction: {
					status,
					reason: reason || 'auto',
					startedAt: createdAt,
				},
			};
			if (id) {
				stampCompactionId(target, id, true);
			}
			this.messages.push(target);
		}

		const previous = target.compaction ?? {
			status: 'in_progress' as const,
			reason: reason || 'auto',
		};
		const completedAt = typeof options.completedAt === 'number' && options.completedAt > 0
			? options.completedAt
			: Date.now();
		const nextStartedAt = previous.startedAt
			?? (typeof startedAt === 'number' && startedAt > 0 ? startedAt : undefined);
		const next = {
			...previous,
			status,
			reason: reason || previous.reason,
			...(nextStartedAt != null ? { startedAt: nextStartedAt } : {}),
			completedAt,
			...(nextStartedAt != null ? { durationMs: Math.max(0, completedAt - nextStartedAt) } : {}),
			...(tokens && typeof tokens === 'object' ? { tokens } : {}),
		};
		if (status === 'failed') {
			if (error) {
				next.error = error;
			}
		} else {
			// A late success supersedes a timeout failure: the card's error text
			// must not survive next to a completed summary.
			delete next.error;
		}
		target.compaction = next;
		// 终态 id 是权威身份：它必须覆盖 started 阶段可能拿到的 inputID。
		if (id) {
			stampCompactionId(target, id, true);
		}
		if (status === 'completed' && typeof summary === 'string' && summary.trim().length > 0) {
			target.content = summary;
		}
		return target;
	}

	/**
	 * 把迟到的回合失败原因落到转录里。
	 *
	 * 本地 180s 兜底超时已经报过一次失败，所以这条修正必须**改写**那一行而不是
	 * 再追加一条 —— 同一个失败回合出现两个错误气泡会被读成两次失败。若末尾没有
	 * ERROR 行（迟到错误并不总有本地超时在前），则追加一条。
	 *
	 * @returns 是否改写了已存在的末尾 ERROR 行
	 */
	replaceLastErrorMessage(message: string): boolean {
		if (!message || message.trim() === '') {
			return false;
		}
		const last = this.messages.length - 1;
		if (last >= 0 && this.messages[last].type === MessageType.ERROR) {
			this.messages[last].content = message;
			this.messages[last].timestamp = Date.now();
			return true;
		}
		this.messages.push(createMessage(MessageType.ERROR, message));
		return false;
	}

	/**
	 * 按 opencode 消息 id 删除消息 —— 服务端权威删除在宿主的落地。
	 *
	 * opencode 的 revert 只是写一个「此处往后作废」的指针，真正的删除发生在下一次
	 * prompt：服务端先跑 cleanup 把 revert 点之后的消息删掉，再落新的用户消息，并对
	 * 每条被删消息广播 message.removed。宿主必须跟着删，否则它会一直揣着已作废的
	 * 消息，继续发消息时又把这些内容推回 webview（表现为「撤回的消息复活」）。
	 *
	 * id 落在 raw 上：历史转换器写 raw.id，rewind 修补过的用户消息可能是 raw.uuid，
	 * 顶层也可能带一份。三种写法都检查。
	 *
	 * @returns 是否至少删掉一条
	 */
	removeMessagesByIds(messageIds: readonly string[]): boolean {
		if (!messageIds || messageIds.length === 0) {
			return false;
		}
		const ids = new Set(messageIds.filter((id) => typeof id === 'string' && id.length > 0));
		if (ids.size === 0) {
			return false;
		}
		const before = this.messages.length;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (messageMatchesAnyProviderId(this.messages[i], ids)) {
				this.messages.splice(i, 1);
			}
		}
		return this.messages.length !== before;
	}

	/**
	 * 从当前 revert 边界起（含该条）裁掉后续全部消息。
	 *
	 * 在追加新用户消息前调用，与服务端即将执行的动作对齐：pending revert 会在下一次
	 * prompt 开始时生效，边界之后的消息即将消失。先在本地裁掉，推给 webview 的快照
	 * 就不会把已作废的那一轮带回去 —— 否则那些消息会先闪现，直到 message.removed
	 * 到达才消失。
	 *
	 * 无 revert、或边界 id 为空 / 本地找不到时是 no-op（此时仍由权威的
	 * message.removed 事件纠正状态）。
	 *
	 * @returns 是否裁掉了内容
	 */
	trimMessagesFromRevertBoundary(): boolean {
		const boundaryId = this.revertState?.messageID;
		if (!boundaryId) {
			return false;
		}
		const ids = new Set([boundaryId]);
		const idx = this.messages.findIndex((m) => messageMatchesAnyProviderId(m, ids));
		if (idx < 0) {
			return false;
		}
		// 含边界本身：未指定 partID 时服务端从边界消息起删（SessionRevert.cleanup）。
		this.messages.splice(idx);
		return true;
	}

	updateLastModifiedTime(): void {
		this.lastModifiedTime = Date.now();
	}
	getWindowBaseIndex(): number {
		return 0;
	}
	getTotalCount(): number {
		return this.messages.length;
	}
}

/** Convenience constructor for a ChatMessage. */
export function createMessage(
	type: MessageType,
	content: string,
	raw?: unknown,
	timestamp: number = Date.now(),
): ChatMessage {
	return { type, content, timestamp, raw };
}

/** 给压缩记录写入引擎消息 id（历史行与实时卡共用的身份）。 */
function stampCompactionId(message: ChatMessage, id: string, overwrite: boolean): void {
	if (!id) {
		return;
	}
	const raw: Record<string, unknown> = message.raw && typeof message.raw === 'object'
		? { ...(message.raw as Record<string, unknown>) }
		: { type: 'compaction' };
	if (overwrite || raw.id == null || raw.id === '') {
		raw.id = id;
	}
	if (overwrite || raw.uuid == null || raw.uuid === '') {
		raw.uuid = id;
	}
	message.raw = raw;
}

/**
 * 消息是否命中任一 opencode 消息 id。
 *
 * id 的落点随来源而变：转换器写 raw.id，rewind 修补过的用户消息走 raw.uuid，顶层
 * 也可能有一份。三种写法都检查，服务端事件里的 id 才能匹配到对应消息。
 */
function messageMatchesAnyProviderId(
	message: ChatMessage | undefined | null,
	ids: ReadonlySet<string>,
): boolean {
	if (!message || ids.size === 0) {
		return false;
	}
	const topLevelId = (message as { id?: unknown }).id;
	if (typeof topLevelId === 'string' && ids.has(topLevelId)) {
		return true;
	}
	const raw = message.raw as Record<string, unknown> | undefined;
	if (raw && typeof raw === 'object') {
		if (typeof raw.id === 'string' && ids.has(raw.id)) {
			return true;
		}
		if (typeof raw.uuid === 'string' && ids.has(raw.uuid)) {
			return true;
		}
	}
	return false;
}
