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
	/** 本 tab 的文件上下文开关（宿主快照值，webview 直接采用）。 */
	autoOpenFileEnabled: boolean;
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
		readonly autoOpenFileEnabled: boolean = false,
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
			autoOpenFileEnabled: this.autoOpenFileEnabled,
		};
	}
}
