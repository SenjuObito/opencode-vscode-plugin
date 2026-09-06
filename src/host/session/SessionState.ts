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
	if (mode == null) return null;
	const trimmed = mode.trim();
	if (trimmed.length === 0) return null;
	// Backward compatibility: old UI value 'default' maps to opencode 'build'.
	return trimmed === 'default' ? 'build' : trimmed;
}

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isValidReasoningEffort(effort: string | null | undefined): boolean {
	return effort != null && VALID_REASONING_EFFORTS.has(effort.trim());
}

/** 活跃会话窗口硬上限：超过即从头部逐出（内存封顶，与会话总长度无关）。
 * 全量权威在 opencode server，逐出的消息可经 load_earlier_messages 回源。 */
export const HOST_WINDOW_MESSAGES = 400;
/** 逐出滞后区间：一次逐出到该目标，避免每条消息都触发逐出。 */
export const HOST_WINDOW_TARGET = 300;

export interface SessionWindowInfo {
	/** 窗口首条在会话中的全局序号（被逐出的条数）。 */
	baseIndex: number;
	/** 窗口内条数。 */
	windowLength: number;
	/** 会话累计条数（含已逐出）。 */
	totalSeen: number;
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

	// ── 消息历史（滑动窗口）──
	private readonly messages: ChatMessage[] = [];
	/** messages[0] 在会话中的全局序号（= 已从头部逐出的条数）。 */
	private windowBaseIndex = 0;
	/** 会话累计条数（含已逐出）。 */
	private totalSeen = 0;
	/** 窗口滑动（逐出发生）时的通知，宿主据此推送 webview 窗口状态。 */
	private onWindowChanged: ((info: SessionWindowInfo) => void) | null = null;

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
		// state 前截断到 32K/块，窗口内存 = 条数上限 × 每条常数。
		this.messages.push(truncateMessageRawForState(message));
		this.totalSeen++;
		this.maybeEvict();
	}
	clearMessages(): void {
		this.messages.length = 0;
		this.windowBaseIndex = 0;
		this.totalSeen = 0;
	}
	updateLastModifiedTime(): void {
		this.lastModifiedTime = Date.now();
	}

	// ── 滑动窗口 ──
	getWindowBaseIndex(): number {
		return this.windowBaseIndex;
	}
	getTotalCount(): number {
		return this.totalSeen;
	}
	getWindowInfo(): SessionWindowInfo {
		return {
			baseIndex: this.windowBaseIndex,
			windowLength: this.messages.length,
			totalSeen: this.totalSeen,
		};
	}
	/**
	 * 恢复路径：collector 只回传 transcript 窗口（tail 保留），窗口基址与
	 * 全量总数直接采纳，不依赖逐条 addMessage 的累计（那只能数到窗口长度）。
	 */
	adoptTranscriptWindow(firstIndex: number, total: number): void {
		this.windowBaseIndex = Math.max(0, Math.floor(firstIndex));
		this.totalSeen = Math.max(Math.floor(total), this.messages.length);
	}
	setOnWindowChanged(listener: ((info: SessionWindowInfo) => void) | null): void {
		this.onWindowChanged = listener;
	}

	/**
	 * 窗口逐出：超过 HOST_WINDOW_MESSAGES 时从头部裁到 HOST_WINDOW_TARGET。
	 * 只动头部、尾部永远完整（当前 turn 的乐观气泡/流式消息不受影响）。
	 * 撤销（revert）激活期间冻结逐出——revert 占位条按边界消息 id 切片，
	 * 边界被逐出会让占位条悬空。
	 */
	private maybeEvict(): void {
		if (this.messages.length <= HOST_WINDOW_MESSAGES) {
			return;
		}
		let evictCount = this.messages.length - HOST_WINDOW_TARGET;
		const revert = this.revertState;
		if (revert) {
			const boundaryIdx = this.messages.findIndex(
				(m) => m.raw != null && typeof m.raw === 'object' && (m.raw as { id?: unknown }).id === revert.messageID,
			);
			// 边界不在窗口内（异常/边界更靠前）：保守起见冻结本次逐出
			if (boundaryIdx < 0) {
				return;
			}
			evictCount = Math.min(evictCount, boundaryIdx);
		}
		if (evictCount <= 0) {
			return;
		}
		this.messages.splice(0, evictCount);
		this.windowBaseIndex += evictCount;
		this.onWindowChanged?.(this.getWindowInfo());
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
