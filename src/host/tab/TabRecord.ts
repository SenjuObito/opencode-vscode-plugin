import { TabId } from './TabId';
import { SessionId } from './SessionId';
import { TabState } from './TabState';
import { TabSettings } from './TabSettings';
import { TabSessionActor } from './TabSessionActor';
import { TabQueue } from './TabQueue';
import { TabEventSink } from './TabEvent';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SessionCallbackAdapter } from '../session/SessionCallbackAdapter';
import type { StreamMessageCoalescer } from '../session/StreamMessageCoalescer';

/**
 * Host-side owner of one tab's session resources and per-tab settings.
 * There is deliberately NO `active` flag here (active is a view-level concept).
 */
export class TabRecord {
	private static readonly MAX_SETTLED_TURNS = 256;

	readonly tabId: TabId;
	readonly cwd: string;
	readonly actor: TabSessionActor;
	readonly settings: TabSettings = new TabSettings();
	/** The tab's own outbox; only `TabQueuePump` consumes it. */
	readonly queue: TabQueue = new TabQueue();
	private eventSink: TabEventSink;

	private state: TabState = TabState.NEW;
	private sessionId: SessionId | null = null;
	private session: OpenCodeSession | null = null;
	private adapter: SessionCallbackAdapter | null = null;
	private coalescer: StreamMessageCoalescer | null = null;

	private _epoch = 0;
	private streamingStartedAtMillis = 0;
	private lastTurnDurationMs = 0;

	private readonly settledTurns = new Map<number, boolean>();
	private readonly settledTurnOrder: number[] = [];

	constructor(tabId: TabId, cwd: string = '', eventSink?: TabEventSink) {
		this.tabId = tabId;
		this.cwd = cwd;
		this.actor = new TabSessionActor(tabId);
		this.eventSink = eventSink || (() => {});
	}

	getTabId(): TabId {
		return this.tabId;
	}

	getCwd(): string {
		return this.cwd;
	}

	getEventSink(): TabEventSink {
		return this.eventSink;
	}

	setEventSink(sink: TabEventSink): void {
		this.eventSink = sink;
	}

	getActor(): TabSessionActor {
		return this.actor;
	}

	getSettings(): TabSettings {
		return this.settings;
	}

	getTitle(): string {
		return this.settings.getTitle();
	}

	getState(): TabState {
		return this.state;
	}

	setState(state: TabState): void {
		const prev = this.state;
		this.state = state;
		if (state === TabState.STREAMING && prev !== TabState.STREAMING) {
			this.streamingStartedAtMillis = Date.now();
		} else if (prev === TabState.STREAMING && state !== TabState.STREAMING) {
			if (this.streamingStartedAtMillis > 0) {
				this.lastTurnDurationMs = Date.now() - this.streamingStartedAtMillis;
				this.streamingStartedAtMillis = 0;
			}
		}
	}

	getSessionId(): SessionId | null {
		return this.sessionId;
	}

	getSessionIdString(): string | null {
		return this.sessionId ? this.sessionId.value : null;
	}

	setSessionId(sessionId: SessionId | null): void {
		this.sessionId = sessionId;
	}

	getSession(): OpenCodeSession | null {
		return this.session;
	}

	getAdapter(): SessionCallbackAdapter | null {
		return this.adapter;
	}

	getCoalescer(): StreamMessageCoalescer | null {
		return this.coalescer;
	}

	setSessionResources(
		sessionId: SessionId,
		session: OpenCodeSession | null,
		adapter: SessionCallbackAdapter | null,
		coalescer: StreamMessageCoalescer | null,
	): void {
		this.sessionId = sessionId;
		this.session = session;
		this.adapter = adapter;
		this.coalescer = coalescer;
	}

	/**
	 * 登记一个尚未拿到服务端会话 id 的会话（首次发送前的 CREATING 态）。
	 *
	 * 与 `setSessionResources` 的区别：这里不假装有一个 SessionId —— 之前为了复用
	 * 该方法传过 `null as unknown as SessionId`，把「未绑定」写成了「绑定到空」，
	 * 是真实的类型谎言。会话 id 由 `TabRegistry.bind` 在服务端分配后写入。
	 */
	attachPendingSession(
		session: OpenCodeSession | null,
		adapter: SessionCallbackAdapter | null,
		coalescer: StreamMessageCoalescer | null,
	): void {
		this.sessionId = null;
		this.session = session;
		this.adapter = adapter;
		this.coalescer = coalescer;
	}

	get epoch(): number {
		return this._epoch;
	}

	getEpoch(): number {
		return this._epoch;
	}

	bumpEpoch(): number {
		return ++this._epoch;
	}

	isClosed(): boolean {
		return this.state === TabState.CLOSED;
	}

	isBound(): boolean {
		return this.sessionId !== null;
	}

	isStreaming(): boolean {
		return this.state === TabState.STREAMING;
	}

	close(): void {
		if (this.state === TabState.CLOSED) {
			return;
		}
		this.state = TabState.CLOSED;
		this.actor.close();
		if (this.session) {
			try {
				this.session.dispose();
			} catch {
				// ignore
			}
			this.session = null;
		}
		this.adapter = null;
		this.coalescer = null;
	}

	getLastTurnDurationMs(): number {
		return this.lastTurnDurationMs;
	}

	/**
	 * Remember a settled turn id. Returns true if first seen, false if duplicate.
	 * Max bounded to 256.
	 */
	rememberSettledTurn(turnId: number): boolean {
		if (this.settledTurns.has(turnId)) {
			return false;
		}
		if (this.settledTurnOrder.length >= TabRecord.MAX_SETTLED_TURNS) {
			const oldest = this.settledTurnOrder.shift();
			if (oldest !== undefined) {
				this.settledTurns.delete(oldest);
			}
		}
		this.settledTurns.set(turnId, true);
		this.settledTurnOrder.push(turnId);
		return true;
	}

	isTurnSettled(turnId: number): boolean {
		return this.settledTurns.has(turnId);
	}
}
