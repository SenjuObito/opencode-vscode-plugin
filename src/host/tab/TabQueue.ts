import { PluginFileLogger } from '../util/PluginFileLogger';

/**
 * TabQueue — one tab's outbox.
 *
 * <p>Why it lives on the host: only the host knows when a turn really settled
 * (`turn.settled`, `SessionState.isBusy()`), and the webview's `loading` flag
 * is a projection that lags a commit behind. The old global queue in the
 * webview consumed "the active tab became idle", so a queue item enqueued in A
 * was sent to B after a tab switch. A queue owned by the tab cannot be stolen
 * by another tab: every item carries the tab and session it was frozen in.</p>
 *
 * <p>The queue itself is inert — `TabQueuePump` is the only consumer, and it
 * takes at most one item at a time ({@link take}) per tab.</p>
 */
export interface TabQueueAttachment {
	attachmentId: string;
	fileName?: string;
	mediaType?: string;
}

export interface TabQueueFileTag {
	displayPath: string;
	absolutePath: string;
}

/** Session commands the queue may consume in order with the user's prompts. */
export const TAB_QUEUE_COMMANDS = [
	'/compact',
	'/undo',
	'/redo',
	'/fork',
	'/share',
	'/unshare',
] as const;

export type TabQueueCommand = typeof TAB_QUEUE_COMMANDS[number];

export function isTabQueueCommand(value: unknown): value is TabQueueCommand {
	return typeof value === 'string' && (TAB_QUEUE_COMMANDS as readonly string[]).includes(value);
}

/** Frozen arguments a queued command needs when it finally runs. */
export interface TabQueueCommandArgs {
	/** `/undo`: the user message that was newest when the command was queued. */
	messageId?: string;
	/** `/fork`: the tab the forked session will be bound to. */
	targetTabId?: string;
}

/**
 * A send frozen at enqueue time.
 *
 * <p>`text` is already quote-expanded and stripped of zero-width characters,
 * attachments are already uploaded under this tab, and the settings are the
 * ones the user saw. None of that may be re-resolved at send time: the active
 * tab (and therefore "current" model/mode/attachments) may belong to someone
 * else by then.</p>
 */
export interface TabQueueItem {
	/** Webview-generated; also used as the `session.send` request id. */
	id: string;
	text: string;
	/**
	 * When set, the item is a session command rather than a prompt. It is
	 * dispatched to the host command handler instead of `session.send`, and the
	 * queue waits for that command's own result before taking the next item.
	 */
	command?: TabQueueCommand;
	commandArgs?: TabQueueCommandArgs;
	fileTags?: TabQueueFileTag[];
	attachments?: TabQueueAttachment[];
	permissionMode?: string | null;
	model?: string | null;
	reasoningEffort?: string | null;
	/** The session this tab was bound to when the item was enqueued. */
	originSessionId: string | null;
	originTabEpoch: number;
	createdAt: number;
}

export interface TabQueueError {
	itemId: string;
	message: string;
}

export interface TabQueueJson {
	items: Array<{
		id: string;
		text: string;
		command?: TabQueueCommand;
		attachments: TabQueueAttachment[];
		model?: string | null;
		permissionMode?: string | null;
		reasoningEffort?: string | null;
		createdAt: number;
	}>;
	paused: boolean;
	lastError: TabQueueError | null;
}

export class TabQueue {
	static readonly MAX_ITEMS = 50;
	static readonly MAX_TEXT_LENGTH = 256 * 1024;

	private readonly pending: TabQueueItem[] = [];
	private inflight: TabQueueItem | null = null;
	private pausedFlag = false;
	private compactingFlag = false;
	private lastError: TabQueueError | null = null;

	/** Append one frozen send. Returns a reason when the item is refused. */
	enqueue(item: TabQueueItem): { ok: true } | { ok: false; reason: string } {
		if (!item.id) {
			return { ok: false, reason: 'queue item is missing an id' };
		}
		if (!item.text && !(item.attachments && item.attachments.length > 0)) {
			return { ok: false, reason: 'queue item is empty' };
		}
		if (item.text.length > TabQueue.MAX_TEXT_LENGTH) {
			return { ok: false, reason: 'queued message is too long' };
		}
		if (this.pending.length >= TabQueue.MAX_ITEMS) {
			return { ok: false, reason: `queue is full (${TabQueue.MAX_ITEMS} items)` };
		}
		if (this.pending.some((queued) => queued.id === item.id) || this.inflight?.id === item.id) {
			return { ok: false, reason: 'queue item id is already used' };
		}
		this.pending.push(item);
		// A new item is a fresh intent: an old failure banner must not keep the
		// pump stopped forever.
		this.lastError = null;
		return { ok: true };
	}

	items(): readonly TabQueueItem[] {
		return this.pending;
	}

	size(): number {
		return this.pending.length;
	}

	isEmpty(): boolean {
		return this.pending.length === 0 && this.inflight === null;
	}

	getInflight(): TabQueueItem | null {
		return this.inflight;
	}

	getInflightId(): string | null {
		return this.inflight?.id ?? null;
	}

	/** The command the pump is currently executing, or null for a prompt. */
	getInflightCommand(): TabQueueCommand | null {
		return this.inflight?.command ?? null;
	}

	/**
	 * Move the head item to `inflight`.
	 *
	 * <p>Atomic on purpose: a duplicated drain trigger must never send the same
	 * item twice. Until {@link complete} runs, `take` returns null.</p>
	 */
	take(): TabQueueItem | null {
		if (this.inflight) {
			return null;
		}
		const next = this.pending.shift();
		if (!next) {
			return null;
		}
		this.inflight = next;
		return next;
	}

	/** The in-flight turn settled: the item is consumed. */
	complete(): void {
		this.inflight = null;
	}

	/** The send failed: put the item back at the head and stop the pump. */
	fail(message: string): void {
		const item = this.inflight;
		this.inflight = null;
		if (item) {
			this.pending.unshift(item);
			this.lastError = { itemId: item.id, message };
		}
	}

	/** Remove a pending item. Removing the failed item clears the error. */
	remove(itemId: string): boolean {
		const index = this.pending.findIndex((item) => item.id === itemId);
		if (index < 0) {
			return false;
		}
		this.pending.splice(index, 1);
		if (this.lastError?.itemId === itemId) {
			this.lastError = null;
		}
		if (this.pending.length === 0) {
			this.pausedFlag = false;
		}
		return true;
	}

	/** Drop every pending item; the in-flight turn is already accepted. */
	clear(): { removed: TabQueueItem[] } {
		const removed = this.pending.splice(0, this.pending.length);
		this.lastError = null;
		this.pausedFlag = false;
		return { removed };
	}

	/** Drop everything, including the in-flight item (tab close / rebind). */
	clearAll(): { removed: TabQueueItem[] } {
		const removed = this.clear().removed;
		const inflight = this.inflight;
		this.inflight = null;
		if (inflight) {
			removed.unshift(inflight);
		}
		return { removed };
	}

	pause(): void {
		if (this.pending.length > 0) {
			this.pausedFlag = true;
		}
	}

	/**
	 * User confirmed: resume consuming. A failed item that was put back at the
	 * head is retried — the failure banner must not outlive the confirmation
	 * and keep the pump stopped.
	 */
	resume(): void {
		this.pausedFlag = false;
		this.lastError = null;
	}

	isPaused(): boolean {
		return this.pausedFlag;
	}

	setCompacting(compacting: boolean): void {
		this.compactingFlag = compacting;
	}

	isCompacting(): boolean {
		return this.compactingFlag;
	}

	getError(): TabQueueError | null {
		return this.lastError;
	}

	toJson(): TabQueueJson {
		const describe = (item: TabQueueItem) => ({
			id: item.id,
			text: item.text,
			command: item.command,
			attachments: item.attachments ?? [],
			model: item.model ?? null,
			permissionMode: item.permissionMode ?? null,
			reasoningEffort: item.reasoningEffort ?? null,
			createdAt: item.createdAt,
		});
		// The in-flight item is deliberately absent: it is no longer queued, it
		// is already on its way to the session. Only waiting items are projected,
		// so the view's queue list is exactly "what will be sent next".
		return {
			items: this.pending.map(describe),
			paused: this.pausedFlag,
			lastError: this.lastError,
		};
	}

	log(tabId: string, action: string, detail: string): void {
		PluginFileLogger.info(
			'queue',
			`${action} tab=${tabId} pending=${this.pending.length} inflight=${this.inflight?.id ?? '-'} paused=${this.pausedFlag} ${detail}`,
		);
	}
}
