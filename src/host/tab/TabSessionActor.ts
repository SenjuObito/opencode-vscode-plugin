import { PluginFileLogger } from '../util/PluginFileLogger';
import { TabId } from './TabId';

/**
 * Serial queue of async operations for a single tab.
 * Different tabs run their actors in parallel; within one tab, tasks execute sequentially.
 */
export class TabSessionActor {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private rejected = 0;

	constructor(readonly tabId: TabId) {}

	submit(task: () => void | Promise<void>): boolean {
		if (this.closed) {
			this.rejected++;
			PluginFileLogger.warn('actor', `task rejected for closed tab ${this.tabId.value}, rejected count=${this.rejected}`);
			return false;
		}
		this.tail = this.tail.then(async () => {
			if (this.closed) {
				return;
			}
			try {
				await task();
			} catch (err) {
				PluginFileLogger.warn('actor', `task failed in tab ${this.tabId.value}: ${String(err)}`);
			}
		});
		return true;
	}

	isClosed(): boolean {
		return this.closed;
	}

	getRejectedCount(): number {
		return this.rejected;
	}

	close(): void {
		this.closed = true;
	}
}
