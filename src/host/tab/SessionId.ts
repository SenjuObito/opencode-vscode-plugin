/**
 * Canonical opencode session identity.
 * Only ids reported by the opencode server (ses_*) belong here.
 */
export class SessionId {
	static readonly PREFIX = 'ses_';
	readonly value: string;

	constructor(value: string) {
		if (!value || typeof value !== 'string' || value.trim().length === 0) {
			throw new Error('sessionId must not be blank');
		}
		const trimmed = value.trim();
		if (!trimmed.startsWith(SessionId.PREFIX)) {
			throw new Error(`not a canonical opencode session id: ${trimmed}`);
		}
		this.value = trimmed;
	}

	static of(value: string): SessionId {
		return new SessionId(value);
	}

	/**
	 * Tries to parse a string as a SessionId. Returns null if invalid or not prefixed with ses_.
	 */
	static tryParse(value: string | null | undefined): SessionId | null {
		if (!value || typeof value !== 'string' || !value.startsWith(SessionId.PREFIX)) {
			return null;
		}
		return new SessionId(value);
	}

	toString(): string {
		return this.value;
	}

	equals(other: unknown): boolean {
		if (this === other) {
			return true;
		}
		if (!(other instanceof SessionId)) {
			return false;
		}
		return this.value === other.value;
	}
}
