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

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isValidReasoningEffort(effort: string | null | undefined): boolean {
	return effort != null && VALID_REASONING_EFFORTS.has(effort.trim());
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

	// Setters
	setSessionId(sessionId: string | null): void {
		this.sessionId = sessionId;
	}
	setChannelId(channelId: string | null): void {
		this.channelId = channelId;
	}
	setBusy(busy: boolean): void {
		this.busy = busy;
	}
	setLoading(loading: boolean): void {
		this.loading = loading;
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
