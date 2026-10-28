import { EventCatalog } from '../router/EventCatalog';

/**
 * Protocol v2 host-to-webview event envelope.
 */
export interface TabEventEnvelope {
	v: 2;
	type: string;
	fn?: string;
	tabId: string;
	epoch: number;
	sessionId?: string | null;
	turnId?: number | null;
	seq?: number | null;
	payload: Record<string, unknown>;
}

export class TabEvent {
	readonly v = 2 as const;
	readonly type: string;
	readonly fn?: string;
	readonly tabId: string;
	readonly epoch: number;
	readonly sessionId?: string | null;
	readonly turnId?: number | null;
	readonly seq?: number | null;
	readonly payload: Record<string, unknown>;

	constructor(params: {
		type: string;
		fn?: string;
		tabId: string;
		epoch: number;
		sessionId?: string | null;
		turnId?: number | null;
		seq?: number | null;
		payload: Record<string, unknown>;
	}) {
		this.type = params.type;
		this.fn = params.fn || EventCatalog.functionName(params.type) || undefined;
		this.tabId = params.tabId;
		this.epoch = params.epoch;
		this.sessionId = params.sessionId ?? null;
		this.turnId = params.turnId ?? null;
		this.seq = params.seq ?? null;
		this.payload = params.payload;
	}

	toEnvelope(): TabEventEnvelope {
		return {
			v: 2,
			type: this.type,
			fn: this.fn,
			tabId: this.tabId,
			epoch: this.epoch,
			sessionId: this.sessionId,
			turnId: this.turnId,
			seq: this.seq,
			payload: this.payload,
		};
	}
}

export type TabEventSink = (event: TabEvent) => void;
