import { randomUUID } from 'crypto';

/**
 * Stable identity of one chat tab inside a webview.
 * Deliberately distinct from SessionId.
 */
export class TabId {
	readonly value: string;

	constructor(value: string) {
		if (!value || typeof value !== 'string' || value.trim().length === 0) {
			throw new Error('tabId must not be blank');
		}
		this.value = value.trim();
	}

	static create(): TabId {
		return new TabId(`tab-${randomUUID()}`);
	}

	static of(value: string): TabId {
		return new TabId(value);
	}

	toString(): string {
		return this.value;
	}

	equals(other: unknown): boolean {
		if (this === other) {
			return true;
		}
		if (!(other instanceof TabId)) {
			return false;
		}
		return this.value === other.value;
	}
}
