import type { WebviewChannel } from '../router/HandlerContext';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface ViewRecord {
	viewId: string;
	channel: WebviewChannel;
	visible: boolean;
	focused: boolean;
	generation: number;
	lastActiveAt: number;
}

/**
 * Manages registered webview views (sidebar left, sidebar right, editor panels).
 * Implements election for promptHostId: focused view > most recently visible view > first available.
 */
export class ViewRegistry {
	private readonly views = new Map<string, ViewRecord>();
	private promptHostId: string | null = null;
	private onPromptHostChanged?: (newHostId: string | null) => void;

	constructor(onPromptHostChanged?: (newHostId: string | null) => void) {
		this.onPromptHostChanged = onPromptHostChanged;
	}

	setOnPromptHostChanged(callback: (newHostId: string | null) => void): void {
		this.onPromptHostChanged = callback;
	}

	register(viewId: string, channel: WebviewChannel): ViewRecord {
		let record = this.views.get(viewId);
		if (record) {
			record.channel = channel;
			record.generation++;
			record.lastActiveAt = Date.now();
		} else {
			record = {
				viewId,
				channel,
				visible: true,
				focused: false,
				generation: 1,
				lastActiveAt: Date.now(),
			};
			this.views.set(viewId, record);
		}
		this.reelectPromptHost();
		PluginFileLogger.info('ViewRegistry', `View registered: ${viewId}, gen=${record.generation}`);
		return record;
	}

	unregister(viewId: string): void {
		if (this.views.delete(viewId)) {
			PluginFileLogger.info('ViewRegistry', `View unregistered: ${viewId}`);
			this.reelectPromptHost();
		}
	}

	has(viewId: string): boolean {
		return this.views.has(viewId);
	}

	get(viewId: string): ViewRecord | null {
		return this.views.get(viewId) || null;
	}

	setVisible(viewId: string, visible: boolean): void {
		const record = this.views.get(viewId);
		if (!record) {return;}
		record.visible = visible;
		if (visible) {
			record.lastActiveAt = Date.now();
		}
		this.reelectPromptHost();
	}

	setFocused(viewId: string, focused: boolean): void {
		const record = this.views.get(viewId);
		if (!record) {return;}
		record.focused = focused;
		if (focused) {
			record.lastActiveAt = Date.now();
			record.visible = true;
		}
		this.reelectPromptHost();
	}

	getPromptHostId(): string | null {
		return this.promptHostId;
	}

	/**
	 * Prompt host election:
	 * 1. Focused and visible view
	 * 2. Most recently active visible view
	 * 3. Any view
	 */
	reelectPromptHost(): void {
		let chosen: ViewRecord | null = null;

		for (const record of this.views.values()) {
			if (record.channel.isDisposed()) {
				continue;
			}
			if (record.focused && record.visible) {
				chosen = record;
				break;
			}
		}

		if (!chosen) {
			// If current prompt host is still alive and visible, retain it
			if (this.promptHostId) {
				const current = this.views.get(this.promptHostId);
				if (current && !current.channel.isDisposed() && current.visible) {
					chosen = current;
				}
			}
		}

		if (!chosen) {
			let latest = 0;
			for (const record of this.views.values()) {
				if (record.channel.isDisposed() || !record.visible) {
					continue;
				}
				if (record.lastActiveAt > latest) {
					latest = record.lastActiveAt;
					chosen = record;
				}
			}
		}

		if (!chosen && this.views.size > 0) {
			chosen = this.views.values().next().value || null;
		}

		const nextHostId = chosen ? chosen.viewId : null;
		if (nextHostId !== this.promptHostId) {
			this.promptHostId = nextHostId;
			PluginFileLogger.info('ViewRegistry', `Prompt host reelected to: ${String(nextHostId)}`);
			this.onPromptHostChanged?.(nextHostId);
		}
	}

	allChannels(): WebviewChannel[] {
		const channels: WebviewChannel[] = [];
		for (const record of this.views.values()) {
			if (!record.channel.isDisposed()) {
				channels.push(record.channel);
			}
		}
		return channels;
	}

	size(): number {
		return this.views.size;
	}
}
