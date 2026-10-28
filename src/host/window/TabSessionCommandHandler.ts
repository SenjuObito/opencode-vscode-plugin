import { TabCommand } from '../tab/TabCommand';
import { TabEvent } from '../tab/TabEvent';
import { TabRegistry } from '../tab/TabRegistry';
import { TabEventRouter } from './TabEventRouter';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface TabSessionCommandHandlerOptions {
	registry: TabRegistry;
	eventRouter: TabEventRouter;
	daemon: () => OpenCodeDaemonBridge | null;
	resolveCwd: () => string | undefined;
	onForkBound?: (targetTabId: string, newSessionId: string) => void;
}

/**
 * Handles tab-scoped session commands: fork, revert, unrevert, compact, share/unshare.
 * Always dispatches events stamped with the routed tabId and sessionId.
 */
export class TabSessionCommandHandler {
	constructor(private readonly options: TabSessionCommandHandlerOptions) {}

	/**
	 * Fork the session of the routed tab into the reserved target tab.
	 */
	async fork(command: TabCommand): Promise<void> {
		const sourceTabId = command.tabId.value;
		const targetTabId = command.string('targetTabId');
		if (!targetTabId) {
			this.publishForkFailure(sourceTabId, null, 'the fork must name its target tab');
			return;
		}

		const sourceRecord = this.options.registry.get(command.tabId);
		const sourceSessionId = sourceRecord?.getSessionIdString();
		if (!sourceRecord || !sourceSessionId) {
			this.publishForkFailure(sourceTabId, null, 'the source tab has no session to fork');
			return;
		}

		const daemon = this.options.daemon();
		if (!daemon || !daemon.isAlive()) {
			this.publishForkFailure(sourceTabId, sourceSessionId, 'daemon is not alive');
			return;
		}

		const messageId = command.string('messageId');
		const params: Record<string, unknown> = {
			sessionId: sourceSessionId,
			cwd: this.options.resolveCwd(),
		};
		if (messageId) {
			params.messageID = messageId;
		}

		daemon.request('opencode.forkSession', params, {
			onLine: () => {},
			onError: (err) => {
				PluginFileLogger.warn('TabSessionCommandHandler', `Fork failed: ${err}`);
				this.publishForkFailure(sourceTabId, sourceSessionId, err);
			},
			onComplete: (success) => {
				if (!success) {
					this.publishForkFailure(sourceTabId, sourceSessionId, 'fork session failed');
					return;
				}
			},
		});
	}

	private publishForkFailure(sourceTabId: string, sourceSessionId: string | null, error: string): void {
		this.options.eventRouter.publish(
			new TabEvent({
				type: 'session.fork.failed',
				tabId: sourceTabId,
				epoch: 0,
				sessionId: sourceSessionId,
				payload: { data: error, error },
			}),
		);
	}

	/**
	 * Revert session to message index or checkpoint.
	 */
	async revert(command: TabCommand): Promise<void> {
		const tabId = command.tabId.value;
		const record = this.options.registry.get(command.tabId);
		const sessionId = record?.getSessionIdString();
		if (!record || !sessionId) {
			this.publishRevertFailure(tabId, null, 'tab has no session');
			return;
		}

		const messageId = command.string('messageId');
		const daemon = this.options.daemon();
		if (!daemon || !daemon.isAlive()) {
			this.publishRevertFailure(tabId, sessionId, 'daemon is not alive');
			return;
		}

		daemon.request('opencode.revert', { sessionId, messageId, cwd: this.options.resolveCwd() }, {
			onLine: () => {},
			onError: (err) => this.publishRevertFailure(tabId, sessionId, err),
			onComplete: (success) => {
				if (!success) {
					this.publishRevertFailure(tabId, sessionId, 'revert failed');
				}
			},
		});
	}

	private publishRevertFailure(tabId: string, sessionId: string | null, error: string): void {
		this.options.eventRouter.publish(
			new TabEvent({
				type: 'session.revert.failed',
				tabId,
				epoch: 0,
				sessionId,
				payload: { error },
			}),
		);
	}

	/**
	 * Unrevert session.
	 */
	async unrevert(command: TabCommand): Promise<void> {
		const tabId = command.tabId.value;
		const record = this.options.registry.get(command.tabId);
		const sessionId = record?.getSessionIdString();
		if (!record || !sessionId) {return;}

		const daemon = this.options.daemon();
		if (!daemon || !daemon.isAlive()) {return;}

		daemon.request('opencode.unrevert', { sessionId, cwd: this.options.resolveCwd() }, {
			onLine: () => {},
			onError: (err) => PluginFileLogger.warn('TabSessionCommandHandler', `unrevert failed: ${err}`),
			onComplete: () => {},
		});
	}

	/**
	 * Compact session history.
	 */
	async compact(command: TabCommand): Promise<void> {
		const tabId = command.tabId.value;
		const record = this.options.registry.get(command.tabId);
		const sessionId = record?.getSessionIdString();
		if (!record || !sessionId) {
			this.options.eventRouter.publish(
				new TabEvent({
					type: 'session.compact.failed',
					tabId,
					epoch: 0,
					sessionId: null,
					payload: { error: 'tab has no session' },
				}),
			);
			return;
		}

		const daemon = this.options.daemon();
		if (!daemon || !daemon.isAlive()) {
			this.options.eventRouter.publish(
				new TabEvent({
					type: 'session.compact.failed',
					tabId,
					epoch: 0,
					sessionId,
					payload: { error: 'daemon is not alive' },
				}),
			);
			return;
		}

		daemon.request('opencode.compact', { sessionId, cwd: this.options.resolveCwd() }, {
			onLine: () => {},
			onError: (err) => {
				this.options.eventRouter.publish(
					new TabEvent({
						type: 'session.compact.failed',
						tabId,
						epoch: 0,
						sessionId,
						payload: { error: err },
					}),
				);
			},
			onComplete: (success) => {
				if (success) {
					this.options.eventRouter.publish(
						new TabEvent({
							type: 'session.compact.done',
							tabId,
							epoch: 0,
							sessionId,
							payload: { success: true },
						}),
					);
				}
			},
		});
	}

	/**
	 * Session share/unshare (dormant per D8, entrances hidden).
	 */
	share(command: TabCommand): void {
		PluginFileLogger.info('TabSessionCommandHandler', `share invoked (dormant per D8) for tab ${command.tabId.value}`);
	}

	unshare(command: TabCommand): void {
		PluginFileLogger.info('TabSessionCommandHandler', `unshare invoked (dormant per D8) for tab ${command.tabId.value}`);
	}
}
