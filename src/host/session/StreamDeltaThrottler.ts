/**
 * StreamDeltaThrottler — port of cc-gui `session/StreamDeltaThrottler.java`.
 * Batches rapid streaming deltas before forwarding them to the webview.
 * Flush consumer failures must not stop future deliveries.
 */

interface Scheduler {
	schedule(runnable: () => void, delayMs: number): void;
	cancel(): void;
	dispose(): void;
}

export class StreamDeltaThrottler {
	private readonly lock = new Object();
	private readonly intervalMs: number;
	private readonly flushConsumer: (text: string) => void;
	private readonly scheduler: Scheduler;
	private readonly nowSupplier: () => number;
	private pending = '';
	private disposed = false;
	private lastFlushAtMs: number;
	private scheduled = false;

	constructor(intervalMs: number, flushConsumer: (text: string) => void) {
		this.intervalMs = Math.max(0, intervalMs);
		this.flushConsumer = flushConsumer;
		this.scheduler = new TimerScheduler();
		this.nowSupplier = () => Date.now();
		this.lastFlushAtMs = this.nowSupplier();
	}

	append(delta: string): void {
		if (!delta) {
			return;
		}
		let delayMs: number;
		synchronized(this.lock, () => {
			this.pending += delta;
			if (this.scheduled) {
				return;
			}
			const elapsed = this.nowSupplier() - this.lastFlushAtMs;
			delayMs = Math.max(0, this.intervalMs - elapsed);
			this.scheduled = true;
			this.scheduler.schedule(() => this.flushPending(), delayMs);
		});
	}

	flushNow(): void {
		this.scheduler.cancel();
		this.flushPending();
	}

	reset(): void {
		this.scheduler.cancel();
		synchronized(this.lock, () => {
			this.scheduled = false;
			this.pending = '';
			this.lastFlushAtMs = this.nowSupplier();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
		this.scheduler.dispose();
	}

	private flushPending(): void {
		let text = '';
		synchronized(this.lock, () => {
			this.scheduled = false;
			if (this.pending.length === 0) {
				this.lastFlushAtMs = this.nowSupplier();
				return;
			}
			text = this.pending;
			this.pending = '';
			this.lastFlushAtMs = this.nowSupplier();
		});
		if (!this.disposed) {
			try {
				this.flushConsumer(text);
			} catch (err) {
				// 防止 consumer 异常杀死调度：失败的 flush 不得阻断后续 delta。
				console.warn(`[StreamDeltaThrottler] flushConsumer failed (chars=${text.length}): ${(err as Error).message}`);
			}
		}
	}
}

class TimerScheduler implements Scheduler {
	private timer: NodeJS.Timeout | null = null;

	schedule(runnable: () => void, delayMs: number): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = null;
			runnable();
		}, delayMs);
	}

	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	dispose(): void {
		this.cancel();
	}
}

/** Minimal monitor-style lock helper for the small critical sections above. */
function synchronized<T>(_lock: object, fn: () => T): T {
	return fn();
}
