import { TabRegistry } from '../tab/TabRegistry';
import { TabId } from '../tab/TabId';
import { TabRecord } from '../tab/TabRecord';
import { TabState } from '../tab/TabState';
import { TabEvent } from '../tab/TabEvent';
import { TabCommand, TabCommandRouter, TabCommandRouteResult } from '../tab';
import { ViewRegistry, ViewRecord } from './ViewRegistry';
import { TabEventRouter } from './TabEventRouter';
import { PromptRegistry } from '../prompt/PromptRegistry';
import { TabSessionCommandHandler } from './TabSessionCommandHandler';
import { TabContextCommandHandler } from './TabContextCommandHandler';
import { HostCommand, RequestIdDeduplicator, CommandRejectCode } from '../router/HostCommand';
import type { WebviewChannel, FileOps } from '../router/HandlerContext';
import type { SettingsService } from '../settings/SettingsService';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface ChatWindowOptions {
	settings: SettingsService;
	daemon: OpenCodeDaemonBridge;
	fileOps: FileOps;
	fallbackWorkingDirectoryResolver: () => string | null;
}

/**
 * ChatWindow — Top-level owner for all tabs and views in VS Code (Single Instance, Multiple Views).
 * Owns TabRegistry, ViewRegistry, PromptRegistry, TabEventRouter and TabCommandRouter.
 */
export class ChatWindow {
	readonly registry: TabRegistry;
	readonly viewRegistry: ViewRegistry;
	readonly promptRegistry: PromptRegistry;
	readonly eventRouter: TabEventRouter;
	readonly commandRouter: TabCommandRouter;
	readonly sessionCommandHandler: TabSessionCommandHandler;
	readonly contextCommandHandler: TabContextCommandHandler;
	readonly deduplicator = new RequestIdDeduplicator(2048);

	private readonly settings: SettingsService;
	private readonly daemon: OpenCodeDaemonBridge;
	private readonly fileOps: FileOps;
	private readonly fallbackWorkingDirectoryResolver: () => string | null;

	constructor(options: ChatWindowOptions) {
		this.settings = options.settings;
		this.daemon = options.daemon;
		this.fileOps = options.fileOps;
		this.fallbackWorkingDirectoryResolver = options.fallbackWorkingDirectoryResolver;

		this.registry = new TabRegistry();
		this.promptRegistry = new PromptRegistry();
		this.viewRegistry = new ViewRegistry((newHostId) => {
			this.eventRouter.publish(
				new TabEvent({
					type: 'prompt.host.changed',
					tabId: this.registry.getActiveTabId()?.value || '',
					epoch: 0,
					payload: { viewId: newHostId },
				}),
			);
		});
		this.eventRouter = new TabEventRouter(this.viewRegistry);
		this.registry.setEventSink((event) => this.eventRouter.publish(event));

		this.commandRouter = new TabCommandRouter(this.registry);
		this.sessionCommandHandler = new TabSessionCommandHandler({
			registry: this.registry,
			eventRouter: this.eventRouter,
			daemon: () => this.daemon,
			resolveCwd: () => this.fallbackWorkingDirectoryResolver() ?? undefined,
			onForkBound: (targetTabId, newSessionId) => {
				PluginFileLogger.info('ChatWindow', `Fork bound: tab=${targetTabId}, ses=${newSessionId}`);
			},
		});

		this.contextCommandHandler = new TabContextCommandHandler(() => this.daemon);

		this.registerBuiltinTabCommands();
		this.registerContextCommands();
		this.ensureInitialTab();
	}

	private ensureInitialTab(): TabRecord {
		if (this.registry.size() === 0) {
			const initialId = TabId.create();
			const cwd = this.fallbackWorkingDirectoryResolver() || '';
			const record = this.registry.create(initialId, cwd);
			this.eventRouter.setActiveTabId(initialId.value);
			return record;
		}
		return this.registry.liveTabs()[0];
	}

	private registerBuiltinTabCommands(): void {
		// tab.create
		this.commandRouter.register('tab.create', (command) => {
			const tabId = command.tabId;
			const cwd = this.fallbackWorkingDirectoryResolver() || '';
			const record = this.registry.create(tabId, cwd);
			this.registry.activate(tabId);
			this.eventRouter.setActiveTabId(tabId.value);

			this.eventRouter.publish(
				new TabEvent({
					type: 'tab.created',
					tabId: tabId.value,
					epoch: record.epoch,
					payload: { tabId: tabId.value, title: record.getTitle() },
				}),
			);
			this.eventRouter.publish(
				new TabEvent({
					type: 'tab.activated',
					tabId: tabId.value,
					epoch: record.epoch,
					payload: { tabId: tabId.value },
				}),
			);
		});

		// tab.activate
		this.commandRouter.register('tab.activate', (command) => {
			const tabId = command.tabId;
			this.registry.activate(tabId);
			this.eventRouter.setActiveTabId(tabId.value);

			this.eventRouter.publish(
				new TabEvent({
					type: 'tab.activated',
					tabId: tabId.value,
					epoch: this.registry.get(tabId)?.epoch || 0,
					payload: { tabId: tabId.value },
				}),
			);
		});

		// tab.close
		this.commandRouter.register('tab.close', (command) => {
			const tabId = command.tabId;
			this.promptRegistry.rejectForTab(tabId.value);
			const closed = this.registry.close(tabId);
			if (closed) {
				this.eventRouter.publish(
					new TabEvent({
						type: 'tab.closed',
						tabId: tabId.value,
						epoch: closed.epoch,
						payload: { tabId: tabId.value },
					}),
				);

				if (this.registry.size() === 0) {
					const next = this.ensureInitialTab();
					this.registry.activate(next.getTabId());
					this.eventRouter.setActiveTabId(next.getTabId().value);
					this.eventRouter.publish(
						new TabEvent({
							type: 'tab.created',
							tabId: next.getTabId().value,
							epoch: next.epoch,
							payload: { tabId: next.getTabId().value, title: next.getTitle() },
						}),
					);
					this.eventRouter.publish(
						new TabEvent({
							type: 'tab.activated',
							tabId: next.getTabId().value,
							epoch: next.epoch,
							payload: { tabId: next.getTabId().value },
						}),
					);
				} else {
					const active = this.registry.getActiveTabId();
					if (active) {
						this.eventRouter.setActiveTabId(active.value);
						this.eventRouter.publish(
							new TabEvent({
								type: 'tab.activated',
								tabId: active.value,
								epoch: this.registry.get(active)?.epoch || 0,
								payload: { tabId: active.value },
							}),
						);
					}
				}
			}
		});

		// tab.title.set
		this.commandRouter.register('tab.title.set', (command) => {
			const record = this.registry.get(command.tabId);
			if (record) {
				const title = command.string('title') || '';
				record.getSettings().applyUserTitle(title);
				this.eventRouter.publish(
					new TabEvent({
						type: 'tab.title.changed',
						tabId: command.tabId.value,
						epoch: record.epoch,
						sessionId: record.getSessionIdString(),
						payload: { title, source: 'user' },
					}),
				);
			}
		});

		// tab.reorder
		this.commandRouter.register('tab.reorder', (command) => {
			const rawOrder = command.payload.tabIds;
			if (Array.isArray(rawOrder)) {
				const newOrder = rawOrder
					.filter((id) => typeof id === 'string')
					.map((id) => TabId.of(id as string));
				this.registry.reorder(newOrder);
				this.eventRouter.publish(
					new TabEvent({
						type: 'tab.reordered',
						tabId: this.registry.getActiveTabId()?.value || '',
						epoch: 0,
						payload: { tabIds: this.registry.getOrder().map((t) => t.value) },
					}),
				);
			}
		});

		// tab.draft.changed
		this.commandRouter.register('tab.draft.changed', (command) => {
			const record = this.registry.get(command.tabId);
			if (record) {
				const draft = command.string('draft') || '';
				record.getSettings().setDraft(draft);
				this.eventRouter.publish(
					new TabEvent({
						type: 'tab.draft.changed',
						tabId: command.tabId.value,
						epoch: record.epoch,
						payload: { tabId: command.tabId.value, draft },
					}),
				);
			}
		});

		// session operations
		this.commandRouter.register('session.fork', (cmd) => this.sessionCommandHandler.fork(cmd));
		this.commandRouter.register('session.revert', (cmd) => this.sessionCommandHandler.revert(cmd));
		this.commandRouter.register('session.unrevert', (cmd) => this.sessionCommandHandler.unrevert(cmd));
		this.commandRouter.register('session.compact', (cmd) => this.sessionCommandHandler.compact(cmd));
		this.commandRouter.register('session.share', (cmd) => this.sessionCommandHandler.share(cmd));
		this.commandRouter.register('session.unshare', (cmd) => this.sessionCommandHandler.unshare(cmd));
	}

	private registerContextCommands(): void {
		// 上下文注入开关（per tab）：webview 在切换「自动附带当前文件」时发送。
		this.commandRouter.register('context.refresh', (cmd, record) => {
			this.contextCommandHandler.refreshContext(cmd, record);
		});
		// 斜杠命令列表（per tab 的 cwd）：webview 打 `/` 与 tab 切换时发送。
		this.commandRouter.register('commands.refresh', (cmd, record) => {
			this.contextCommandHandler.refreshCommands(cmd, record);
		});
	}

	registerView(viewId: string, channel: WebviewChannel): ViewRecord {		const record = this.viewRegistry.register(viewId, channel);
		this.resyncView(viewId, channel);
		return record;
	}

	unregisterView(viewId: string): void {
		this.viewRegistry.unregister(viewId);
	}

	resyncView(viewId: string, channel: WebviewChannel): void {
		const snapshots = this.registry.snapshots().map((s) => s.toJson());
		const activeTabId = this.registry.getActiveTabId()?.value || null;
		const promptHostId = this.viewRegistry.getPromptHostId();

		const payload = {
			tabs: snapshots,
			activeTabId,
			promptHostId,
			viewId,
		};

		channel.postRaw({
			type: 'host.events',
			batch: [
				{
					v: 2,
					type: 'tab.resync',
					fn: 'onTabResync',
					tabId: activeTabId || '',
					epoch: 0,
					payload,
				},
			],
		});
	}

	rejectCommand(viewId: string, tabId: string, requestId: string, code: CommandRejectCode, message: string): void {
		const view = this.viewRegistry.get(viewId);
		if (!view) {return;}
		view.channel.postRaw({
			type: 'host.events',
			batch: [
				{
					v: 2,
					type: 'command.rejected',
					fn: 'onCommandRejected',
					tabId,
					epoch: 0,
					payload: { tabId, requestId, code, message },
				},
			],
		});
	}

	async handleViewCommand(viewId: string, rawMessage: unknown): Promise<void> {
		if (!rawMessage || typeof rawMessage !== 'object') {return;}

		const { command, reject } = HostCommand.parse(rawMessage);
		if (reject) {
			this.rejectCommand(viewId, reject.tabId, reject.requestId, reject.code, reject.message);
			return;
		}
		if (!command) {return;}

		const type = command.type;

		// 1. View lifecycle
		if (type === 'view.ready') {
			const view = this.viewRegistry.get(viewId);
			if (view) {
				this.resyncView(viewId, view.channel);
			}
			return;
		}

		if (type === 'view.focus') {
			const focused = command.payload.focused === true;
			this.viewRegistry.setFocused(viewId, focused);
			return;
		}

		// 2. Request deduplication (if requestId is present)
		if (command.requestId && !this.deduplicator.checkAndRecord(command.requestId)) {
			PluginFileLogger.warn('ChatWindow', `Duplicate requestId rejected: ${command.requestId}`);
			this.rejectCommand(
				viewId,
				command.tabId?.value || '',
				command.requestId,
				CommandRejectCode.DUPLICATE_REQUEST,
				`Duplicate requestId: ${command.requestId}`,
			);
			return;
		}

		// 3. Command routing
		if (this.commandRouter.handles(type)) {
			if (type === 'tab.create') {
				const createTabId = command.tabId ?? TabId.create();
				const tabCmd = TabCommand.of(createTabId.value, type, command.requestId, command.payload);
				await this.commandRouter.route(tabCmd);
				return;
			}

			const targetTabId = command.tabId ?? this.registry.getActiveTabId();
			if (!targetTabId) {
				this.rejectCommand(
					viewId,
					'',
					command.requestId,
					CommandRejectCode.MISSING_TAB_ID,
					`Command ${type} requires a target tab, but no tabId was provided and no active tab exists`,
				);
				return;
			}

			const record = this.registry.get(targetTabId);
			if (!record) {
				this.rejectCommand(
					viewId,
					targetTabId.value,
					command.requestId,
					CommandRejectCode.TAB_NOT_FOUND,
					`Tab ${targetTabId.value} not found`,
				);
				return;
			}

			// Validate session match if command explicitly specifies sessionId
			if (command.sessionId && record.getSessionId() && !command.sessionId.equals(record.getSessionId()!)) {
				this.rejectCommand(
					viewId,
					targetTabId.value,
					command.requestId,
					CommandRejectCode.SESSION_MISMATCH,
					`Session mismatch: command specifies ${command.sessionId.value} but tab is bound to ${record.getSessionIdString()}`,
				);
				return;
			}

			const tabCmd = TabCommand.of(targetTabId.value, type, command.requestId, command.payload);
			const result = await this.commandRouter.route(tabCmd);
			if (result === TabCommandRouteResult.UNKNOWN_TAB) {
				this.rejectCommand(
					viewId,
					targetTabId.value,
					command.requestId,
					CommandRejectCode.TAB_NOT_FOUND,
					`Tab ${targetTabId.value} not found`,
				);
			} else if (result === TabCommandRouteResult.UNKNOWN_COMMAND) {
				this.rejectCommand(
					viewId,
					targetTabId.value,
					command.requestId,
					CommandRejectCode.UNKNOWN_TYPE,
					`Command ${type} is not supported`,
				);
			}
			return;
		}

		// If command is unknown to commandRouter
		this.rejectCommand(
			viewId,
			command.tabId?.value || '',
			command.requestId,
			CommandRejectCode.UNKNOWN_TYPE,
			`Unknown command type: ${type}`,
		);
	}
}
