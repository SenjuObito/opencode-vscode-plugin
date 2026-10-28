import { PluginFileLogger } from '../util/PluginFileLogger';

/**
 * Buffers data lines of a new send until its canonical session id ([SESSION_ID]) is known.
 * Bounded by 30 seconds bootstrap timeout.
 */
export class PendingSend {
	static readonly BOOTSTRAP_TIMEOUT_MS = 30000;

	private readonly buffered: string[] = [];
	private sessionSink: ((line: string) => void) | null = null;
	private timeoutAction: (() => void) | null = null;
	private _sessionId: string | null = null;
	private completed = false;
	private timedOut = false;
	private bootstrapTimeoutEnabled = true;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		readonly requestId: string,
		readonly tabId: string,
		private readonly markerConsumer: (line: string) => void,
	) {
		if (!requestId) {
			throw new Error('requestId is required');
		}
		this.timer = setTimeout(() => this.expire(), PendingSend.BOOTSTRAP_TIMEOUT_MS);
	}

	get sessionId(): string | null {
		return this._sessionId;
	}

	isTimedOut(): boolean {
		return this.timedOut;
	}

	isBootstrapTimeoutEnabled(): boolean {
		return this.bootstrapTimeoutEnabled;
	}

	static sessionIdOf(line: string | null | undefined): string | null {
		if (!line || !line.startsWith('[SESSION_ID]')) {
			return null;
		}
		let value = line.slice('[SESSION_ID]'.length).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		return value.length > 0 ? value : null;
	}

	onLine(line: string): void {
		if (this.completed) {
			return;
		}
		const markerSession = PendingSend.sessionIdOf(line);
		if (markerSession) {
			this._sessionId = markerSession;
			this.markerConsumer(line);
			return;
		}
		if (!this._sessionId || !this.sessionSink) {
			this.buffered.push(line);
			return;
		}
		this.sessionSink(line);
	}

	bindSession(sessionId: string): void {
		if (!this._sessionId && sessionId && sessionId.trim().length > 0) {
			this._sessionId = sessionId.trim();
		}
	}

	attach(sink: (line: string) => void): void {
		if (this.completed) {
			return;
		}
		this.sessionSink = sink;
		for (const line of this.buffered) {
			sink(line);
		}
		this.buffered.length = 0;
	}

	complete(): void {
		this.completed = true;
		this.buffered.length = 0;
		this.sessionSink = null;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	setTimeoutAction(action: () => void): void {
		this.timeoutAction = action;
	}

	disableBootstrapTimeout(): void {
		this.bootstrapTimeoutEnabled = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	expireNow(): void {
		this.expire();
	}

	private expire(): void {
		let fire = false;
		if (this.bootstrapTimeoutEnabled && !this.completed && !this._sessionId && !this.timedOut) {
			this.timedOut = true;
			this.completed = true;
			this.buffered.length = 0;
			fire = true;
			PluginFileLogger.warn('PendingSend', `bootstrap timed out for req=${this.requestId}, tab=${this.tabId}`);
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (fire && this.timeoutAction) {
			try {
				this.timeoutAction();
			} catch (err) {
				PluginFileLogger.warn('PendingSend', `timeoutAction error: ${String(err)}`);
			}
		}
	}
}
