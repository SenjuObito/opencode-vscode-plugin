import { TabId } from '../tab/TabId';
import { SessionId } from '../tab/SessionId';

export interface HostCommandWire {
	v?: number;
	type: string;
	requestId?: string;
	tabId?: string;
	sessionId?: string | null;
	payload?: Record<string, unknown>;
	[key: string]: unknown;
}

export enum CommandRejectCode {
	UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
	UNKNOWN_TYPE = 'UNKNOWN_TYPE',
	MISSING_REQUEST_ID = 'MISSING_REQUEST_ID',
	MISSING_TAB_ID = 'MISSING_TAB_ID',
	TAB_NOT_FOUND = 'TAB_NOT_FOUND',
	SESSION_MISMATCH = 'SESSION_MISMATCH',
	DUPLICATE_REQUEST = 'DUPLICATE_REQUEST',
	INVALID_PAYLOAD = 'INVALID_PAYLOAD',
}

export interface CommandRejectPayload {
	tabId: string;
	requestId: string;
	code: CommandRejectCode;
	message: string;
}

/**
 * LRU cache for requestId deduplication (capacity 2048).
 */
export class RequestIdDeduplicator {
	private readonly capacity: number;
	private readonly set = new Set<string>();
	private readonly queue: string[] = [];

	constructor(capacity = 2048) {
		this.capacity = capacity;
	}

	/** Returns true if newly added, false if already seen (duplicate). */
	checkAndRecord(requestId: string): boolean {
		if (!requestId) {
			return true;
		}
		if (this.set.has(requestId)) {
			return false;
		}
		this.set.add(requestId);
		this.queue.push(requestId);
		if (this.queue.length > this.capacity) {
			const oldest = this.queue.shift();
			if (oldest) {
				this.set.delete(oldest);
			}
		}
		return true;
	}

	has(requestId: string): boolean {
		return this.set.has(requestId);
	}

	clear(): void {
		this.set.clear();
		this.queue.length = 0;
	}
}

/**
 * Normalized Host Command (v2) representation.
 */
export class HostCommand {
	constructor(
		readonly v: number,
		readonly type: string,
		readonly requestId: string,
		readonly tabId: TabId | null,
		readonly sessionId: SessionId | null,
		readonly payload: Record<string, unknown>,
	) {}

	static parse(raw: unknown): { command?: HostCommand; reject?: CommandRejectPayload } {
		if (!raw || typeof raw !== 'object') {
			return {
				reject: {
					tabId: '',
					requestId: '',
					code: CommandRejectCode.INVALID_PAYLOAD,
					message: 'Command payload is not an object',
				},
			};
		}

		const wire = raw as HostCommandWire;
		const requestId = typeof wire.requestId === 'string' ? wire.requestId : '';
		const tabIdStr = typeof wire.tabId === 'string' ? wire.tabId : '';

		if (typeof wire.type !== 'string' || wire.type.trim() === '') {
			return {
				reject: {
					tabId: tabIdStr,
					requestId,
					code: CommandRejectCode.UNKNOWN_TYPE,
					message: 'Command missing type field',
				},
			};
		}

		// Check version: require v === 2 if explicitly given
		if (wire.v !== undefined && wire.v !== 2) {
			return {
				reject: {
					tabId: tabIdStr,
					requestId,
					code: CommandRejectCode.UNSUPPORTED_VERSION,
					message: `Unsupported protocol version: ${String(wire.v)}, expected 2`,
				},
			};
		}

		let tabId: TabId | null = null;
		if (tabIdStr) {
			try {
				tabId = TabId.of(tabIdStr);
			} catch (e) {
				return {
					reject: {
						tabId: tabIdStr,
						requestId,
						code: CommandRejectCode.TAB_NOT_FOUND,
						message: (e as Error).message,
					},
				};
			}
		}

		let sessionId: SessionId | null = null;
		if (typeof wire.sessionId === 'string' && wire.sessionId.trim() !== '') {
			try {
				sessionId = SessionId.of(wire.sessionId);
			} catch (e) {
				return {
					reject: {
						tabId: tabIdStr,
						requestId,
						code: CommandRejectCode.SESSION_MISMATCH,
						message: (e as Error).message,
					},
				};
			}
		}

		// The envelope owns routing identity. Merge it into the payload once so a
		// handler can never be talked into acting on a different tab/session than
		// the one the command names (idea HostCommand does the same).
		const payload = (wire.payload && typeof wire.payload === 'object' ? wire.payload : wire) as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...payload };
		if (tabId) {
			merged.tabId = tabId.value;
		}
		if (sessionId) {
			merged.sessionId = sessionId.value;
		}
		if (!('requestId' in merged) || merged.requestId === null || merged.requestId === '') {
			merged.requestId = requestId;
		}

		return {
			command: new HostCommand(
				wire.v ?? 2,
				wire.type,
				requestId,
				tabId,
				sessionId,
				merged,
			),
		};
	}
}
