/**
 * Represents a turn sequence identity, used for terminal idempotency.
 */
export class TurnId {
	readonly value: number;

	constructor(value: number) {
		if (typeof value !== 'number' || isNaN(value)) {
			throw new Error('turnId must be a valid number');
		}
		this.value = value;
	}

	static of(value: number): TurnId {
		return new TurnId(value);
	}

	static tryParse(value: unknown): TurnId | null {
		if (typeof value === 'number' && !isNaN(value)) {
			return new TurnId(value);
		}
		if (typeof value === 'string' && value.trim().length > 0) {
			const n = Number(value.trim());
			if (!isNaN(n)) {
				return new TurnId(n);
			}
		}
		return null;
	}

	toNumber(): number {
		return this.value;
	}

	toString(): string {
		return String(this.value);
	}

	equals(other: unknown): boolean {
		if (this === other) {
			return true;
		}
		if (!(other instanceof TurnId)) {
			return false;
		}
		return this.value === other.value;
	}
}
