import { TabRegistry } from './TabRegistry';
import { TabCommand } from './TabCommand';
import { TabRecord } from './TabRecord';
import { PluginFileLogger } from '../util/PluginFileLogger';

export enum TabCommandRouteResult {
	ROUTED = 'ROUTED',
	DUPLICATE = 'DUPLICATE',
	UNKNOWN_TAB = 'UNKNOWN_TAB',
	UNKNOWN_COMMAND = 'UNKNOWN_COMMAND',
	CLOSED = 'CLOSED',
}

export type TabCommandHandler = (command: TabCommand, record?: TabRecord) => void | Promise<void>;

/**
 * Entry point for tab-scoped commands.
 * - Resolves tabId against registry (never fallback to active tab).
 * - Deduplicates requestId (LRU 2048).
 * - Executes on TabSessionActor to preserve order.
 * - tab.create runs inline.
 */
export class TabCommandRouter {
	private static readonly MAX_REMEMBERED_REQUEST_IDS = 2048;
	private static readonly INLINE_TYPES = new Set(['tab.create']);

	private readonly handlers = new Map<string, TabCommandHandler>();
	private readonly handledRequestIds = new Map<string, boolean>();

	constructor(private readonly registry: TabRegistry) {}

	register(type: string, handler: TabCommandHandler): void {
		if (!type || type.trim().length === 0 || !handler) {
			throw new Error('type and handler are required');
		}
		this.handlers.set(type.trim(), handler);
	}

	handles(type: string): boolean {
		return !!type && this.handlers.has(type.trim());
	}

	async route(command: TabCommand): Promise<TabCommandRouteResult> {
		if (!command) {
			return TabCommandRouteResult.UNKNOWN_COMMAND;
		}

		const requestId = command.requestId;
		if (requestId && this.isRemembered(requestId)) {
			return TabCommandRouteResult.DUPLICATE;
		}

		const handler = this.handlers.get(command.type);
		if (!handler) {
			PluginFileLogger.warn('TabCommandRouter', `unknown command: ${command.type}`);
			return TabCommandRouteResult.UNKNOWN_COMMAND;
		}

		if (TabCommandRouter.INLINE_TYPES.has(command.type)) {
			try {
				await handler(command);
				this.remember(requestId);
				return TabCommandRouteResult.ROUTED;
			} catch (err) {
				PluginFileLogger.warn('TabCommandRouter', `inline command failed: ${command.type}: ${String(err)}`);
				return TabCommandRouteResult.UNKNOWN_TAB;
			}
		}

		const record = this.registry.get(command.tabId);
		if (!record || record.isClosed()) {
			PluginFileLogger.info('TabCommandRouter', `${command.type} for unknown/closed tab ${command.tabId.value}`);
			return TabCommandRouteResult.UNKNOWN_TAB;
		}

		if (!this.remember(requestId)) {
			return TabCommandRouteResult.DUPLICATE;
		}

		const accepted = record.getActor().submit(async () => {
			if (record.isClosed()) {
				return;
			}
			try {
				await handler(command, record);
			} catch (err) {
				PluginFileLogger.warn(
					'TabCommandRouter',
					`command failed: ${command.type} tab=${command.tabId.value}: ${String(err)}`,
				);
			}
		});

		if (!accepted) {
			this.forget(requestId);
			return TabCommandRouteResult.CLOSED;
		}

		return TabCommandRouteResult.ROUTED;
	}

	private isRemembered(requestId: string): boolean {
		if (!requestId) {
			return false;
		}
		return this.handledRequestIds.has(requestId);
	}

	private remember(requestId: string): boolean {
		if (!requestId) {
			return true;
		}
		if (this.handledRequestIds.has(requestId)) {
			return false;
		}
		if (this.handledRequestIds.size >= TabCommandRouter.MAX_REMEMBERED_REQUEST_IDS) {
			const oldestKey = this.handledRequestIds.keys().next().value;
			if (oldestKey !== undefined) {
				this.handledRequestIds.delete(oldestKey);
			}
		}
		this.handledRequestIds.set(requestId, true);
		return true;
	}

	private forget(requestId: string): void {
		if (!requestId) {
			return;
		}
		this.handledRequestIds.delete(requestId);
	}

	rememberedRequestIdCount(): number {
		return this.handledRequestIds.size;
	}
}
