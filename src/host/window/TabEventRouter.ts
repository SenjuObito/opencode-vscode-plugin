import { TabEvent, TabEventEnvelope } from '../tab/TabEvent';
import { EventCatalog } from '../router/EventCatalog';
import { ViewRegistry } from './ViewRegistry';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface EventBatchMessage {
	type: 'host.events';
	batch: TabEventEnvelope[];
}

interface QueuedEvent {
	laneId: string;
	event: TabEvent;
	charSize: number;
}

class EventLane {
	readonly pending: QueuedEvent[] = [];
	snapshotRequired = false;
}

/**
 * TabEventRouter — per-tab lane batching, fair-weight scheduling, and multi-view broadcast.
 * Port of cc-gui BridgeScheduler tailored for VS Code's postMessage channel.
 */
export class TabEventRouter {
	static readonly GLOBAL_LANE = '__global';
	private static readonly MAX_PENDING_PER_LANE = 256;
	private static readonly MAX_BATCH_CALLS = 64;
	private static readonly MAX_BATCH_CHARS = 32_000;
	private static readonly ACTIVE_LANE_WEIGHT = 3;

	private readonly lanes = new Map<string, EventLane>();
	private drainScheduled = false;
	private draining = false;
	private activeTabId: string | null = null;
	private roundRobinIndex = 0;

	constructor(private readonly viewRegistry: ViewRegistry) {}

	setActiveTabId(tabId: string | null): void {
		this.activeTabId = tabId;
	}

	publish(event: TabEvent): void {
		const laneId = event.tabId || TabEventRouter.GLOBAL_LANE;
		let lane = this.lanes.get(laneId);
		if (!lane) {
			lane = new EventLane();
			this.lanes.set(laneId, lane);
		}

		const envelope = event.toEnvelope();
		const charSize = JSON.stringify(envelope).length;
		const queued: QueuedEvent = { laneId, event, charSize };

		// Try delta merging with tail
		if (this.isDelta(event.type) && this.mergeWithTailDelta(lane, queued)) {
			this.scheduleDrain();
			return;
		}

		// Snapshot replaces previous snapshots in lane
		if (this.isSnapshot(event.type)) {
			this.removeQueuedSnapshots(lane);
		}

		if (lane.pending.length >= TabEventRouter.MAX_PENDING_PER_LANE) {
			// Drop oldest non-terminal delta if lane full
			const dropped = this.dropOldestDelta(lane);
			if (!dropped && !this.isTerminal(event.type)) {
				PluginFileLogger.warn('TabEventRouter', `Dropping event, lane ${laneId} is full: ${event.type}`);
				lane.snapshotRequired = true;
				return;
			}
		}

		lane.pending.push(queued);
		this.scheduleDrain();
	}

	private isDelta(type: string): boolean {
		return type === 'content.delta' || type === 'thinking.delta';
	}

	private isSnapshot(type: string): boolean {
		return type === 'message.snapshot';
	}

	private isTerminal(type: string): boolean {
		return type === 'turn.ended' || type === 'turn.settled' || type === 'turn.error';
	}

	private mergeWithTailDelta(lane: EventLane, queued: QueuedEvent): boolean {
		if (lane.pending.length === 0) {return false;}
		const tail = lane.pending[lane.pending.length - 1];
		if (tail.event.type !== queued.event.type) {return false;}
		if (tail.event.turnId !== queued.event.turnId) {return false;}

		const tailDelta = tail.event.payload.delta;
		const nextDelta = queued.event.payload.delta;
		if (typeof tailDelta === 'string' && typeof nextDelta === 'string') {
			tail.event.payload.delta = tailDelta + nextDelta;
			tail.charSize += nextDelta.length;
			return true;
		}
		return false;
	}

	private removeQueuedSnapshots(lane: EventLane): void {
		for (let i = lane.pending.length - 1; i >= 0; i--) {
			if (this.isSnapshot(lane.pending[i].event.type)) {
				lane.pending.splice(i, 1);
			}
		}
	}

	private dropOldestDelta(lane: EventLane): boolean {
		for (let i = 0; i < lane.pending.length; i++) {
			if (this.isDelta(lane.pending[i].event.type)) {
				lane.pending.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	private scheduleDrain(): void {
		if (this.drainScheduled || this.draining) {
			return;
		}
		this.drainScheduled = true;
		queueMicrotask(() => this.drain());
	}

	private drain(): void {
		this.drainScheduled = false;
		if (this.lanes.size === 0) {return;}

		this.draining = true;
		const batch: TabEventEnvelope[] = [];
		let currentChars = 0;

		const laneKeys = Array.from(this.lanes.keys());
		if (laneKeys.length === 0) {
			this.draining = false;
			return;
		}

		// Round-robin with 3x weight for active tab
		const startIdx = this.roundRobinIndex % laneKeys.length;
		for (let offset = 0; offset < laneKeys.length; offset++) {
			const idx = (startIdx + offset) % laneKeys.length;
			const laneId = laneKeys[idx];
			const lane = this.lanes.get(laneId);
			if (!lane || lane.pending.length === 0) {continue;}

			const weight = (this.activeTabId && laneId === this.activeTabId)
				? TabEventRouter.ACTIVE_LANE_WEIGHT
				: 1;

			for (let w = 0; w < weight && lane.pending.length > 0; w++) {
				if (batch.length >= TabEventRouter.MAX_BATCH_CALLS) {break;}
				const next = lane.pending[0];
				if (batch.length > 0 && currentChars + next.charSize > TabEventRouter.MAX_BATCH_CHARS) {
					break;
				}
				lane.pending.shift();
				batch.push(next.event.toEnvelope());
				currentChars += next.charSize;
			}

			if (batch.length >= TabEventRouter.MAX_BATCH_CALLS || currentChars >= TabEventRouter.MAX_BATCH_CHARS) {
				break;
			}
		}

		this.roundRobinIndex = (startIdx + 1) % laneKeys.length;

		// Clean empty lanes
		for (const [key, lane] of this.lanes.entries()) {
			if (lane.pending.length === 0 && key !== TabEventRouter.GLOBAL_LANE && key !== this.activeTabId) {
				this.lanes.delete(key);
			}
		}

		this.draining = false;

		if (batch.length > 0) {
			this.broadcastBatch(batch);
		}

		// If more pending events remain in any lane, schedule next drain
		let hasMore = false;
		for (const lane of this.lanes.values()) {
			if (lane.pending.length > 0) {
				hasMore = true;
				break;
			}
		}
		if (hasMore) {
			this.scheduleDrain();
		}
	}

	dispose(): void {
		this.lanes.clear();
		this.drainScheduled = false;
	}

	private broadcastBatch(batch: TabEventEnvelope[]): void {
		const channels = this.viewRegistry.allChannels();
		if (channels.length === 0) {return;}

		const batchMessage: EventBatchMessage = {
			type: 'host.events',
			batch,
		};

		for (const channel of channels) {
			try {
				channel.postRaw(batchMessage);
				// Legacy function fallback for older webview callbacks
				for (const item of batch) {
					if (item.fn) {
						if (Array.isArray(item.payload?.args)) {
							channel.callJavaScript(item.fn, ...(item.payload.args as string[]));
						} else {
							channel.callJavaScript(item.fn, JSON.stringify(item.payload));
						}
					}
				}
			} catch (err) {
				PluginFileLogger.warn('TabEventRouter', `Failed to broadcast batch to channel: ${String(err)}`);
			}
		}
	}
}
