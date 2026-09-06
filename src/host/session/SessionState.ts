/**
 * Session state management — port of cc-gui `session/SessionState.java`.
 * Holds all state for one conversation (opencode only: provider is fixed).
 */
import { randomUUID } from 'crypto';
import { ChatMessage, MessageType } from './types';

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
		this.messages.push(message);
	}
	clearMessages(): void {
		this.messages.length = 0;
	}
	updateLastModifiedTime(): void {
		this.lastModifiedTime = Date.now();
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
