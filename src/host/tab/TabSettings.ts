export type TitleSource = 'AUTO' | 'USER';

/**
 * Per-tab selections.
 * Changing model/settings in tab A must never affect tab B.
 */
export class TabSettings {
	private provider = 'opencode';
	private model = '';
	private permissionMode = 'default';
	private reasoningEffort = 'default';
	private contextEnabled = true;
	private autoOpenFileEnabled = false;
	private title = '';
	private titleSource: TitleSource = 'AUTO';
	private draft = '';

	getDraft(): string {
		return this.draft;
	}

	setDraft(draft: string): void {
		this.draft = draft || '';
	}

	getProvider(): string {
		return this.provider;
	}

	setProvider(provider: string): void {
		if (provider && provider.trim().length > 0) {
			this.provider = provider.trim();
		}
	}

	getModel(): string {
		return this.model;
	}

	setModel(model: string): void {
		if (model && model.trim().length > 0) {
			this.model = model.trim();
		}
	}

	getPermissionMode(): string {
		return this.permissionMode;
	}

	setPermissionMode(permissionMode: string): void {
		if (permissionMode && permissionMode.trim().length > 0) {
			this.permissionMode = permissionMode.trim();
		}
	}

	getReasoningEffort(): string {
		return this.reasoningEffort;
	}

	setReasoningEffort(reasoningEffort: string): void {
		if (reasoningEffort && reasoningEffort.trim().length > 0) {
			this.reasoningEffort = reasoningEffort.trim();
		}
	}

	isContextEnabled(): boolean {
		return this.contextEnabled;
	}

	setContextEnabled(enabled: boolean): void {
		this.contextEnabled = enabled;
	}

	isAutoOpenFileEnabled(): boolean {
		return this.autoOpenFileEnabled;
	}

	setAutoOpenFileEnabled(enabled: boolean): void {
		this.autoOpenFileEnabled = enabled;
	}

	getTitle(): string {
		return this.title;
	}

	getTitleSource(): TitleSource {
		return this.titleSource;
	}

	/**
	 * Apply an auto title. User title always wins until explicitly updated.
	 */
	applyAutoTitle(title: string): boolean {
		if (!title || title.trim().length === 0) {
			return false;
		}
		if (this.titleSource === 'USER') {
			return false;
		}
		this.title = title.trim();
		this.titleSource = 'AUTO';
		return true;
	}

	/**
	 * Apply a user title and make it authoritative over later auto titles.
	 */
	applyUserTitle(title: string): void {
		this.title = (title || '').trim();
		this.titleSource = 'USER';
	}
}
