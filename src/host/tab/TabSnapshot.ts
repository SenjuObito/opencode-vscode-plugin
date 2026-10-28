/**
 * Immutable view of one tab at a point in time.
 * Used for resync and multi-view synchronization.
 */
export interface TabSnapshotData {
	tabId: string;
	sessionId?: string | null;
	title?: string;
	active: boolean;
	streaming: boolean;
	loading: boolean;
	epoch: number;
	draft?: string;
}

export class TabSnapshot {
	constructor(
		readonly tabId: string,
		readonly sessionId: string | null | undefined,
		readonly title: string,
		readonly active: boolean,
		readonly streaming: boolean,
		readonly loading: boolean,
		readonly epoch: number,
		readonly draft: string = '',
	) {}

	toJson(): TabSnapshotData {
		return {
			tabId: this.tabId,
			sessionId: this.sessionId ?? null,
			title: this.title,
			active: this.active,
			streaming: this.streaming,
			loading: this.loading,
			epoch: this.epoch,
			draft: this.draft,
		};
	}
}
