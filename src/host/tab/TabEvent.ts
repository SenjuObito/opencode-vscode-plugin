import { EventCatalog } from '../router/EventCatalog';

/**
 * Protocol v2 host-to-webview event envelope.
 *
 * <p>Data-plane events carry their identity in named fields: the tab that owns
 * them, the session, the turn and the sequence inside that turn. The webview
 * routes by `tabId`; it never guesses "the tab on screen".</p>
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
	/** `false` = named-only; the bridge must not also invoke `fn` positionally. */
	legacy?: boolean;
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
	/**
	 * Keep the old positional `window.<fn>` call as a bridge fallback.
	 *
	 * <p>Migrated data events set this to false: their payload is an object, so
	 * calling `fn(payload)` would hand the webview a JSON string instead of the
	 * value it expects. Until every handler is named, control events keep the
	 * fallback for older views.</p>
	 */
	readonly legacy: boolean;

	constructor(params: {
		type: string;
		fn?: string;
		tabId: string;
		epoch: number;
		sessionId?: string | null;
		turnId?: number | null;
		seq?: number | null;
		payload: Record<string, unknown>;
		legacy?: boolean;
	}) {
		this.type = params.type;
		this.fn = params.fn || EventCatalog.functionName(params.type) || undefined;
		this.tabId = params.tabId;
		this.epoch = params.epoch;
		this.sessionId = params.sessionId ?? null;
		this.turnId = params.turnId ?? null;
		this.seq = params.seq ?? null;
		this.payload = params.payload;
		this.legacy = params.legacy ?? true;
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
			legacy: this.legacy,
		};
	}

	/**
	 * Re-address the event to the tab that really owns it.
	 *
	 * <p>Legacy publishers only know the session; the publish choke point
	 * resolves the owner tab and rewrites the id so the webview never has to
	 * guess "the tab on screen". Everything else is preserved.</p>
	 */
	withTabId(tabId: string): TabEvent {
		if (!tabId || tabId === this.tabId) {
			return this;
		}
		return new TabEvent({
			type: this.type,
			fn: this.fn,
			tabId,
			epoch: this.epoch,
			sessionId: this.sessionId,
			turnId: this.turnId,
			seq: this.seq,
			payload: this.payload,
			legacy: this.legacy,
		});
	}

	/** Stamp the current binding epoch (the router/lane already knows the lane). */
	withEpoch(epoch: number): TabEvent {
		if (!Number.isFinite(epoch) || epoch === this.epoch) {
			return this;
		}
		return new TabEvent({
			type: this.type,
			fn: this.fn,
			tabId: this.tabId,
			epoch,
			sessionId: this.sessionId,
			turnId: this.turnId,
			seq: this.seq,
			payload: this.payload,
			legacy: this.legacy,
		});
	}
}

export type TabEventSink = (event: TabEvent) => void;
