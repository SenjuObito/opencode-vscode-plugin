import { TabRecord } from '../tab/TabRecord';
import { TabQueueCommand, TabQueueItem } from '../tab/TabQueue';
import { TabState } from '../tab/TabState';
import type { TabSender, TabSendPayload } from '../handlers/TabSender';

/**
 * The surface the pump needs from the window. Injected instead of reaching
 * into ChatWindow so the pump stays testable and cannot read "the active tab".
 */
export interface TabQueuePumpHost {
	getTab(tabId: string): TabRecord | null;
	liveTabs(): TabRecord[];
	/** Push the tab's current queue projection to the views. */
	publishQueue(record: TabRecord): void;
	/** Report a queue problem to the user (toast in the owning tab). */
	reportError(record: TabRecord, message: string): void;
	isDaemonAlive(): boolean;
	hasPendingPrompt(tabId: string): boolean;
	sender(): TabSender | null;
	/**
	 * Dispatch a queued session command (compact/undo/redo/fork/share/unshare).
	 * The pump keeps the item in flight until the command publishes its own
	 * result, so a queued prompt can never overtake it.
	 */
	executeCommand(record: TabRecord, item: TabQueueItem): { ok: boolean; message?: string };
}

/**
 * TabQueuePump — the single consumer of every tab's queue.
 *
 * <p>Invariants:</p>
 * <ul>
 *   <li>One pump per window, one in-flight item per tab.</li>
 *   <li>FIFO inside a tab; tabs progress independently and in parallel.</li>
 *   <li>Never reads the active tab: the record is the routing decision.</li>
 *   <li>Taking an item is atomic, so repeated drain triggers cannot double-send.</li>
 * </ul>
 */
export class TabQueuePump {
	constructor(private readonly host: TabQueuePumpHost) {}

	/** Append an item and try to consume it right away. */
	enqueue(record: TabRecord, item: TabQueueItem): { ok: boolean; reason?: string } {
		const queued = record.queue.enqueue(item);
		if (!queued.ok) {
			record.queue.log(record.getTabId().value, 'enqueue.rejected', `item=${item.id} reason=${queued.reason}`);
			this.host.publishQueue(record);
			return queued;
		}
		record.queue.log(record.getTabId().value, 'enqueue', `item=${item.id} origin=${item.originSessionId ?? '-'}`);
		this.host.publishQueue(record);
		this.drain(record);
		return { ok: true };
	}

	remove(record: TabRecord, itemId: string): void {
		const removed = record.queue.remove(itemId);
		if (!removed) {
			return;
		}
		record.queue.log(record.getTabId().value, 'remove', `item=${itemId}`);
		this.host.publishQueue(record);
		this.drain(record);
	}

	clear(record: TabRecord): void {
		const { removed } = record.queue.clear();
		record.queue.log(record.getTabId().value, 'clear', `removed=${removed.length}`);
		this.host.publishQueue(record);
	}

	/** Drop everything because the tab is switching conversations. Returns what was dropped. */
	clearForSessionSwitch(record: TabRecord): TabQueueItem[] {
		const { removed } = record.queue.clearAll();
		if (removed.length === 0) {
			return [];
		}
		record.queue.log(record.getTabId().value, 'clear.session-switch', `removed=${removed.length}`);
		this.host.publishQueue(record);
		this.host.reportError(
			record,
			`会话已切换，${removed.length} 条排队消息已清空`,
		);
		return removed;
	}

	pause(record: TabRecord): void {
		if (record.queue.isPaused() || record.queue.size() === 0) {
			return;
		}
		record.queue.pause();
		record.queue.log(record.getTabId().value, 'pause', 'user stopped the turn');
		this.host.publishQueue(record);
	}

	resume(record: TabRecord): void {
		// A failed item is put back at the head with its error still set; an
		// explicit "continue" is what retries it, so the error counts as a
		// reason to resume even when the queue was never paused.
		if (!record.queue.isPaused() && !record.queue.getError()) {
			return;
		}
		record.queue.resume();
		record.queue.log(record.getTabId().value, 'resume', 'user confirmed');
		this.host.publishQueue(record);
		this.drain(record);
	}

	/**
	 * A turn reached its terminal state. The in-flight item is consumed; the
	 * next item waits for this event instead of a timer, so exactly one turn is
	 * sent per settlement.
	 */
	onTabSettled(record: TabRecord): void {
		const inflight = record.queue.getInflight();
		// A command item ends on its own result event; a turn settlement must not
		// release it early (a compact or fork can outlive the turn that triggered
		// the drain).
		if (inflight && !inflight.command) {
			record.queue.log(record.getTabId().value, 'settled', `item=${inflight.id}`);
			record.queue.complete();
			this.host.publishQueue(record);
		}
		this.drain(record);
	}

	/**
	 * The result of a queued command arrived.
	 *
	 * <p>Only the item whose command matches may be released: the same event can
	 * be published by a direct header action while another command is queued.</p>
	 */
	onCommandSettled(
		record: TabRecord,
		expected: readonly TabQueueCommand[],
		requestId: string | undefined,
		ok: boolean,
		message?: string,
	): void {
		const inflight = record.queue.getInflight();
		// A result without our request id is not ours: `revert.changed` is also
		// published by replay and by direct header actions.
		if (!inflight?.command || !expected.includes(inflight.command)) {
			return;
		}
		if (!requestId || requestId !== inflight.id) {
			return;
		}
		record.queue.setCompacting(false);
		if (ok) {
			record.queue.log(record.getTabId().value, 'command.done', `item=${inflight.id} command=${inflight.command}`);
			record.queue.complete();
			this.host.publishQueue(record);
			this.drain(record);
			return;
		}
		const reason = message && message.trim() ? message.trim() : `${inflight.command} 执行失败`;
		record.queue.log(record.getTabId().value, 'command.failed', `item=${inflight.id} reason=${reason}`);
		record.queue.fail(reason);
		this.host.publishQueue(record);
		this.host.reportError(record, reason);
	}

	/** A non-terminal "maybe idle now" signal (resume, daemon ready, replay). */
	onTabIdle(record: TabRecord): void {
		this.drain(record);
	}

	/** Sweep every live tab (daemon restarted, view rebuilt). */
	drainAll(): void {
		for (const record of this.host.liveTabs()) {
			this.drain(record);
		}
	}

	/** Refresh the projection for every live tab (view resync). */
	publishAll(): void {
		for (const record of this.host.liveTabs()) {
			this.host.publishQueue(record);
		}
	}

	private canDrain(record: TabRecord): boolean {
		const queue = record.queue;
		if (record.isClosed()) {
			return false;
		}
		const state = record.getState();
		// CREATING is deliberately allowed: it means a provisional session exists
		// and the *first* send is exactly what turns it into a real one. The
		// in-flight guard below already stops a second item from starting.
		if (state === TabState.STREAMING || state === TabState.LOADING_HISTORY) {
			return false;
		}
		const session = record.getSession();
		if (session && (session.state.isBusy() || session.state.isLoading())) {
			return false;
		}
		if (queue.isPaused() || queue.isCompacting() || queue.getInflightId()) {
			return false;
		}
		if (queue.getError()) {
			return false;
		}
		if (queue.size() === 0) {
			return false;
		}
		if (!this.host.isDaemonAlive()) {
			return false;
		}
		// A pending permission/question/plan card must be answered first; the
		// server would otherwise queue our prompt behind a dialog nobody can see.
		if (this.host.hasPendingPrompt(record.getTabId().value)) {
			return false;
		}
		return true;
	}

	private drain(record: TabRecord): void {
		if (!this.canDrain(record)) {
			return;
		}
		record.getActor().submit(async () => {
			// Re-check inside the actor: the tab may have started a turn or been
			// closed between the trigger and this task.
			if (!this.canDrain(record)) {
				return;
			}
			const item = record.queue.take();
			if (!item) {
				return;
			}
			const tabId = record.getTabId().value;
			const bound = record.getSessionIdString();
			if (item.originSessionId !== null && item.originSessionId !== bound) {
				record.queue.fail('会话已切换');
				record.queue.log(tabId, 'drop.stale-origin', `item=${item.id} origin=${item.originSessionId} bound=${bound ?? '-'}`);
				this.host.publishQueue(record);
				this.host.reportError(record, '排队消息所属的会话已切换，已丢弃。');
				return;
			}

			record.queue.log(tabId, 'send', `item=${item.id} command=${item.command ?? '-'} session=${bound ?? '-'}`);
			if (item.command === '/compact') {
				// Compaction is a long request: block the next item until its own
				// result event arrives instead of relying on a server busy flag.
				record.queue.setCompacting(true);
			}
			this.host.publishQueue(record);

			if (item.command) {
				const dispatched = this.host.executeCommand(record, item);
				if (!dispatched.ok) {
					record.queue.setCompacting(false);
					const reason = dispatched.message ?? `${item.command} 无法执行`;
					record.queue.fail(reason);
					record.queue.log(tabId, 'command.failed', `item=${item.id} reason=${reason}`);
					this.host.publishQueue(record);
					this.host.reportError(record, reason);
				}
				return;
			}

			const sender = this.host.sender();
			if (!sender) {
				record.queue.fail('宿主发送通道未就绪');
				record.queue.log(tabId, 'send.failed', `item=${item.id} reason=no-sender`);
				this.host.publishQueue(record);
				this.host.reportError(record, '发送通道未就绪，排队消息已保留。');
				return;
			}

			const outcome = sender.send(tabId, toPayload(record, item), { requestId: item.id });
			if (!outcome.ok) {
				record.queue.fail(outcome.message ?? '发送失败');
				record.queue.log(tabId, 'send.failed', `item=${item.id} reason=${outcome.code ?? 'ERROR'}`);
				this.host.publishQueue(record);
				if (outcome.message) {
					this.host.reportError(record, outcome.message);
				}
				return;
			}
			this.host.publishQueue(record);
		});
	}
}

function toPayload(record: TabRecord, item: TabQueueItem): TabSendPayload {
	const sessionId = record.getSessionIdString() ?? undefined;
	return {
		text: item.text,
		fileTags: item.fileTags ?? null,
		attachments: item.attachments?.map((attachment) => ({
			attachmentId: attachment.attachmentId,
			fileName: attachment.fileName,
			mediaType: attachment.mediaType,
		})),
		permissionMode: item.permissionMode ?? undefined,
		model: item.model ?? undefined,
		reasoningEffort: item.reasoningEffort ?? undefined,
		sessionId,
	};
}
