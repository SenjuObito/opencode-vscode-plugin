import { TabId } from './TabId';

/**
 * One tab-scoped command from webview.
 * requestId is the idempotency key.
 */
export class TabCommand {
	readonly tabId: TabId;
	readonly type: string;
	readonly requestId: string;
	readonly payload: Record<string, unknown>;

	constructor(tabId: TabId, type: string, requestId: string = '', payload: Record<string, unknown> = {}) {
		if (!tabId) {
			throw new Error('tabId is required');
		}
		if (!type || type.trim().length === 0) {
			throw new Error('type must not be blank');
		}
		this.tabId = tabId;
		this.type = type.trim();
		this.requestId = requestId ? requestId.trim() : '';
		this.payload = payload || {};
	}

	static of(tabId: string | TabId, type: string, requestId: string = '', payload: Record<string, unknown> = {}): TabCommand {
		const id = typeof tabId === 'string' ? TabId.of(tabId) : tabId;
		return new TabCommand(id, type, requestId, payload);
	}

	string(key: string): string | null {
		const val = this.payload[key];
		return typeof val === 'string' ? val : null;
	}

	number(key: string): number | null {
		const val = this.payload[key];
		return typeof val === 'number' && !isNaN(val) ? val : null;
	}

	boolean(key: string): boolean | null {
		const val = this.payload[key];
		return typeof val === 'boolean' ? val : null;
	}
}
