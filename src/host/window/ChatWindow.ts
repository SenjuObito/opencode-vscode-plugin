import { TabRegistry } from '../tab/TabRegistry';
import { TabId } from '../tab/TabId';
import { TabRecord } from '../tab/TabRecord';
import { TabState } from '../tab/TabState';
import { TabEvent, TabEventSink } from '../tab/TabEvent';
import { TabCommand, TabCommandRouter, TabCommandRouteResult } from '../tab';
import { TabSessionFactory } from '../tab/TabSessionFactory';
import { ViewRegistry, ViewRecord } from './ViewRegistry';
import { TabEventRouter } from './TabEventRouter';
import { PromptRegistry } from '../prompt/PromptRegistry';
import { TabSessionCommandHandler } from './TabSessionCommandHandler';
import { TabContextCommandHandler } from './TabContextCommandHandler';
import { TabFileCommandHandler } from './TabFileCommandHandler';
import { TabSessionSendHandler } from './TabSessionSendHandler';
import { TabAttachmentCommandHandler } from './TabAttachmentCommandHandler';
import { TabAttachmentStore } from '../attachments/TabAttachmentStore';
import { HostCommand, RequestIdDeduplicator, CommandRejectCode } from '../router/HostCommand';
import type { WebviewChannel, FileOps } from '../router/HandlerContext';
import type { SettingsService } from '../settings/SettingsService';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import type { FileEntry } from '../handlers/FileHandler';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { JsTarget } from '../session/SessionCallbackAdapter';
import type { SessionManager } from '../session/SessionManager';
import { isValidPermissionMode } from '../session/SessionState';
import { convertMessagesToJson } from '../util/MessageJsonConverter';
import { PluginFileLogger } from '../util/PluginFileLogger';

/**
 * 允许不带 tabId 的窗口级命令。
 *
 * <p>方案 §4.4 / INV-4：缺 tabId 的**tab 级**命令必须拒绝，不能回落到活跃 tab；
 * 只有真正与 tab 无关的命令（设置目录、命令列表、活跃 tab 内新建会话）例外。</p>
 */
const WINDOW_SCOPED_COMMANDS = new Set(['agents.list', 'commands.refresh', 'session.new']);

/**
 * Commands whose handler must verify that the tab still holds the session the
 * command was addressed to. The envelope's sessionId is copied into the payload
 * because TabCommand itself only carries tabId.
 */
const SESSION_GUARDED_COMMANDS = new Set([
	'session.fork',
	'session.revert',
	'session.unrevert',
	'session.compact',
	'session.share',
	'session.unshare',
	'permission.reply',
	'question.reply',
	'plan.reply',
]);

export interface ChatWindowOptions {
	settings: SettingsService;
	daemon: OpenCodeDaemonBridge;
	fileOps: FileOps;
	fallbackWorkingDirectoryResolver: () => string | null;
	/**
	 * 为一个 tab 创建会话（输出经 `viewSink` 归属到该 tab）。
	 * 缺省不创建会话——单会话/单测路径保持原样，`TabRecord.getSession()` 为 null。
	 */
	createSession?: (
		viewSink: JsTarget,
		autoOpenFileEnabledResolver?: () => boolean | null | undefined,
		contextEnabledResolver?: () => boolean,
		eventSink?: TabEventSink,
	) => OpenCodeSession | null;
	/** 会话新建后的初始化（从持久化设置回灌 model / mode / effort）。 */
	configureSession?: (session: OpenCodeSession) => void;
	/** 服务端分配了会话 id、且已绑定到 tab 时回调（历史索引 / 标题等）。 */
	onSessionBound?: (tabId: string, sessionId: string) => void;
	/** 把历史会话加载进 tab（`session.load`）：由 ChatInstance 接到 HistoryHandler。 */
	loadSession?: (sessionId: string) => void;
	/**
	 * 附件落盘根目录（通常是 `<globalStorage>/attachments`）。
	 * 缺省 null：附件命令仍会注册，但 prepare 会明确报「附件目录不可用」。
	 */
	attachmentsRoot?: string | null;
	/** 重新枚举 agent 目录（`agents.list`）：由 ChatInstance 接到 AgentHandler。 */
	requestAgents?: () => void;
	/** 保存导出文件（窗口级 `save_json`，不带 tab）。 */
	saveText?: (content: string, filename: string) => void;
	/** 读取子代理 transcript（`subagent.history`，按会话归属）。 */
	loadSubagentHistory?: (payload: string) => void;
	/** v2 提示答复：`permission.reply` / `question.reply` / `plan.reply`。 */
	replyPrompt?: (type: string, payload: Record<string, unknown>, tabId: string) => { ok: boolean; code?: string; reason?: string } | void;
	/**
	 * 列举候选文件（v2 `files.list`）：由 ChatInstance 接到 FileHandler。
	 * 目录由宿主按目标 tab 的 cwd 给出。
	 */
	listFiles?: (query: string, directory: string | undefined) => Promise<FileEntry[]>;
	/**
	 * 关 tab 时被作废的未决 prompt id。
	 * 宿主必须把它们 deny / rejectQuestion 掉，否则服务端一直在等。
	 */
	onPromptsRejected?: (requestIds: string[]) => void;
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
	readonly sessionSendHandler: TabSessionSendHandler;
	readonly fileCommandHandler: TabFileCommandHandler;
	readonly sessionFactory: TabSessionFactory;
	readonly attachments: TabAttachmentStore;
	readonly attachmentCommandHandler: TabAttachmentCommandHandler;
	readonly deduplicator = new RequestIdDeduplicator(2048);

	private readonly options: ChatWindowOptions;
	private readonly daemon: OpenCodeDaemonBridge;
	private readonly fallbackWorkingDirectoryResolver: () => string | null;
	/** 会话 id 分配监听器的注销函数（关闭 tab 时清理）。 */
	private readonly bindingUnsubs = new Map<string, () => void>();
	private sessionManager: SessionManager | null = null;
	/** INV-7：缺失 tab 身份而被丢弃的命令/事件计数（诊断用）。 */
	private unattributedCount = 0;

	constructor(options: ChatWindowOptions) {
		this.options = options;
		this.daemon = options.daemon;
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
		this.registry.setEventSink((event) => {
			// The producing session does not know the tab binding generation;
			// stamp the current one at the single publish choke point so a late
			// event from before a rebind is rejected by the webview.
			const record = this.registry.get(TabId.of(event.tabId));
			this.eventRouter.publish(record ? event.withEpoch(record.getEpoch()) : event);
		});

		this.commandRouter = new TabCommandRouter(this.registry);
		this.sessionCommandHandler = new TabSessionCommandHandler({
			registry: this.registry,
			eventRouter: this.eventRouter,
			daemon: () => this.daemon,
			resolveCwd: () => this.fallbackWorkingDirectoryResolver() ?? undefined,
			onForkBound: (targetTabId, newSessionId) => {
				this.bindForkedSession(targetTabId, newSessionId);
			},
		});

		this.contextCommandHandler = new TabContextCommandHandler(
			() => this.daemon,
			(type, tabId, payload) => this.publishTabEvent(type, tabId, payload),
		);

		this.fileCommandHandler = new TabFileCommandHandler({
			listFiles: (query, directory) =>
				this.options.listFiles
					? this.options.listFiles(query, directory)
					: Promise.resolve([]),
			publish: (tabId, epoch, payload) => {
				this.eventRouter.publish(
					new TabEvent({
						type: 'files.listed',
						tabId,
						epoch,
						payload,
					}),
				);
			},
		});

		this.sessionFactory = new TabSessionFactory(this.registry, {
			newSession: (cwd, tabId) => this.createSessionForTab(cwd, tabId),
			adapterOf: (session) => session.getAdapter() ?? null,
			coalescerOf: (session) => session.getAdapter().getCoalescer() ?? null,
		});
		this.sessionSendHandler = new TabSessionSendHandler({
			ensureSession: (record) => this.ensureTabSession(record),
			replay: (record) => this.replayTab(record),
			reportError: (record, message) => this.publishTabError(record, message),
			resolveAttachment: (tabId, attachmentId) => {
				const resolved = this.attachments.resolve(tabId, attachmentId);
				const data = this.attachments.readBase64(tabId, attachmentId);
				if (!resolved || data == null) {
					return null;
				}
				return { data, fileName: resolved.fileName, mediaType: resolved.mediaType };
			},
		});
		this.attachments = new TabAttachmentStore(this.options.attachmentsRoot ?? null);
		this.attachmentCommandHandler = new TabAttachmentCommandHandler({
			store: () => this.attachments,
			reportError: (record, message) => this.publishTabError(record, message),
		});

		this.registerBuiltinTabCommands();
		this.registerContextCommands();
		this.registerSessionRuntimeCommands();
		this.registerAttachmentCommands();
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
			// 新 tab 是空的：回放（无会话）会把视图清成空态，与旧 create_new_session 等价。
			// 用 setTimeout 让 v2 批次先 drain：否则 legacy 回放会先于 tab.activated
			// 到达其他视图，消息会写进切换前的 tab。
			setTimeout(() => this.replayTab(record), 0);
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
			// 宿主状态权威：后台 tab 的流式输出被投影丢弃，切回时补一份快照。
			// 延后一拍，确保 tab.activated 先于消息快照到达（多视图切换顺序）。
			const record = this.registry.get(tabId);
			if (record) {
				setTimeout(() => this.replayTab(record), 0);
			}
		});

		// tab.close
		this.commandRouter.register('tab.close', (command) => {
			const tabId = command.tabId;
			const rejectedPrompts = this.promptRegistry.rejectForTab(tabId.value);
			if (rejectedPrompts.length > 0) {
				PluginFileLogger.info(
					'ChatWindow',
					`tab ${tabId.value} closed: rejecting ${rejectedPrompts.length} pending prompt(s)`,
				);
				this.options.onPromptsRejected?.(rejectedPrompts);
			}
			this.bindingUnsubs.get(tabId.value)?.();
			this.bindingUnsubs.delete(tabId.value);
			this.attachments.releaseTab(tabId.value);
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
					setTimeout(() => this.replayTab(next), 0);
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
						const nextRecord = this.registry.get(active);
						if (nextRecord) {
							setTimeout(() => this.replayTab(nextRecord), 0);
						}
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
						payload: {
							tabId: command.tabId.value,
							draft,
							// 回显来源视图：发送方忽略自己的回声，避免光标跳动。
							sourceViewId: typeof command.payload.sourceViewId === 'string'
								? command.payload.sourceViewId
								: '',
						},
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

		// session.rename：tab 重命名同步服务端标题（§7.8）。本地标题由 tab.title.set
		// 立即生效；这里只把同一份标题写回 opencode，历史列表/其他设备才能看到。
		this.commandRouter.register('session.rename', (command) => {
			const record = this.registry.get(command.tabId);
			const title = command.string('title')?.trim();
			const sessionId = record?.getSessionIdString();
			if (!record || !title || !sessionId) {
				return;
			}
			record.getSettings().applyUserTitle(title);
			this.daemon.request(
				'opencode.updateSessionTitle',
				{
					sessionId,
					title,
					directory: record.getCwd() || undefined,
				},
				{ onLine: () => {}, onError: () => {}, onComplete: () => {} },
			);
		});

		// subagent.history：按 tab 读取子代理 transcript（A20 修：此前只有 legacy
		// `load_subagent_session`，A19 移植的 AgentGroupBlock 发的 v2 命令无人接收）。
		this.commandRouter.register('subagent.history', (command) => {
			this.options.loadSubagentHistory?.(JSON.stringify(command.payload));
		});
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

		// @ 文件补全候选：结果按 tab 回到发起请求的那个 tab。
		this.commandRouter.register('files.list', (cmd, record) => {
			void this.fileCommandHandler.list(cmd, record);
		});
	}

	private registerSessionRuntimeCommands(): void {
		// 发送 / 中断都按 tab 解析目标会话：B 的操作绝不落到 A 身上。
		this.commandRouter.register('session.send', (cmd, record) => {
			this.sessionSendHandler.send(cmd, record);
		});
		this.commandRouter.register('session.interrupt', (cmd, record) => {
			this.sessionSendHandler.interrupt(cmd, record);
		});
		// 在同一个 tab 内开新对话（/clear、新建对话按钮）：保留 tab，重置会话与绑定。
		this.commandRouter.register('session.new', () => {
			if (!this.sessionManager) {
				PluginFileLogger.warn('ChatWindow', 'session.new ignored: no session manager bound');
				return;
			}
			this.sessionManager.createNewSession();
		});
		// 把历史会话装进目标 tab：先绑定，再交给 HistoryHandler 抓取并回放。
		this.commandRouter.register('session.load', (cmd, record) => {
			const sessionId = cmd.string('sessionId');
			if (!record || !sessionId) {
				return;
			}
			const session = this.switchActiveTabSession(sessionId);
			if (!session) {
				PluginFileLogger.warn(
					'ChatWindow',
					`session.load could not bind ${sessionId} to tab ${record.getTabId().value}`,
				);
				return;
			}
			if (this.options.loadSession) {
				this.options.loadSession(sessionId);
			} else {
				this.replayTab(record);
			}
			const title = cmd.string('title');
			if (title) {
				record.getSettings().applyAutoTitle(title);
			}
		});
		// per-tab 权限模式：webview 切模式时按会话定向写入该 tab。
		this.commandRouter.register('settings.mode', (cmd, record) => {
			const mode = cmd.string('mode');
			if (!record || !mode || !isValidPermissionMode(mode)) {
				return;
			}
			record.getSettings().setPermissionMode(mode);
			record.getSession()?.state.setPermissionMode(mode);
		});
		// per-tab 模型选择：写到目标 tab，不影响别的 tab。
		// `silent` 表示这是切 tab 时回放该 tab 自己的模型，不是用户的新选择——
		// 宿主据此不清空该会话的上下文用量（否则两个不同模型的 tab 来回切，
		// 用量环会每次归零）。
		this.commandRouter.register('settings.model', (cmd, record) => {
			const model = cmd.string('model');
			if (!record || !model) {
				return;
			}
			record.getSettings().setModel(model);
			const session = record.getSession();
			if (!session) {
				return;
			}
			const previousModel = session.getState().getModel();
			session.getState().setModel(model);
			if (!cmd.boolean('silent') && previousModel !== model) {
				// 上下文额度是模型自身的属性：换了模型必须重推用量，
				// 否则用量环停在旧模型的分母上。
				session.republishUsageAfterModelChange();
			}
		});
		// per-tab 推理力度。
		this.commandRouter.register('settings.reasoning', (cmd, record) => {
			const effort = cmd.string('reasoningEffort');
			if (!record || !effort) {
				return;
			}
			record.getSettings().setReasoningEffort(effort);
			record.getSession()?.getState().setReasoningEffort(effort);
		});
		// agent 目录：webview 的 ModeSelect 在未收到过推送时主动要一次。
		this.commandRouter.register('agents.list', () => {
			this.options.requestAgents?.();
		});
		// 未决提示的答复必须回到发起它的 tab/session（idea 的 permission.reply /
		// question.reply / plan.reply）。ChatWindow 先把命令路由到目标 tab，
		// PermissionHandler 再核对 pending 的归属，过期或串 tab 的答复发 command.rejected。
		for (const type of ['permission.reply', 'question.reply', 'plan.reply']) {
			this.commandRouter.register(type, (cmd, record) => {
				const result = this.options.replyPrompt?.(type, cmd.payload, cmd.tabId.value);
				if (result && typeof result === 'object' && result.ok === false) {
					record?.getEventSink()(new TabEvent({
						type: 'command.rejected',
						tabId: cmd.tabId.value,
						epoch: record.epoch,
						payload: {
							tabId: cmd.tabId.value,
							requestId: cmd.requestId,
							code: result.code ?? CommandRejectCode.INVALID_PAYLOAD,
							message: result.reason ?? `${type} rejected`,
						},
						legacy: false,
					}));
				}
			});
		}
	}

	private registerAttachmentCommands(): void {
		this.commandRouter.register('attachment.prepare', (cmd, record) => {
			this.attachmentCommandHandler.prepare(cmd, record);
		});
		this.commandRouter.register('attachment.chunk', (cmd, record) => {
			this.attachmentCommandHandler.chunk(cmd, record);
		});
		this.commandRouter.register('attachment.complete', (cmd, record) => {
			this.attachmentCommandHandler.complete(cmd, record);
		});
		this.commandRouter.register('attachment.abort', (cmd, record) => {
			this.attachmentCommandHandler.abort(cmd, record);
		});
	}

	/**
	 * 接管会话层：让 `context.getSession()` / `sessionManager.getActiveSession()`
	 * 解析到**活跃 tab 自己的会话**，并让新对话 / 切历史落在活跃 tab 上。
	 *
	 * 注入了 resolver 之后 SessionManager 内部那个本地实例只作为兜底存在。
	 */
	bindSessionManager(sessionManager: SessionManager): void {
		this.sessionManager = sessionManager;
		sessionManager.setSessionResolver(() => this.ensureActiveTabSession());
		sessionManager.setSessionLookup((sessionId) => {
			const record = this.registry.findBySession(sessionId);
			return record?.getSession() ?? null;
		});
		sessionManager.setActiveSessionReplacer((sessionId) => this.switchActiveTabSession(sessionId));
	}

	/**
	 * sessionId → tabId（未决弹窗归属用）。
	 * 会话还没绑定时退回活跃 tab —— 首次发送创建的会话就是这样。
	 */
	resolveTabIdForSession(sessionId: string | null): string | null {
		if (sessionId) {
			const owner = this.registry.findBySession(sessionId);
			if (owner) {
				return owner.getTabId().value;
			}
		}
		return this.registry.getActiveTabId()?.value ?? null;
	}

	/**
	 * 把语义事件投给某个 tab（§10.9 的 `files.undo` 等）。
	 *
	 * 事件带上 tab 的 epoch：webview 侧会丢掉比当前绑定更早的事件，
	 * 避免一次 reattach 之前的迟到结果覆盖新会话。
	 */
	publishTabEvent(type: string, tabId: string, payload: Record<string, unknown>): void {
		const record = this.registry.get(TabId.of(tabId));
		this.eventRouter.publish(
			new TabEvent({
				type,
				tabId,
				epoch: record?.epoch ?? 0,
				payload,
			}),
		);
	}


	/** Publish a named event owned by one tab (used by replay / lifecycle paths). */
	private publishRecordEvent(record: TabRecord, type: string, payload: Record<string, unknown>): void {
		record.getEventSink()(new TabEvent({
			type,
			tabId: record.getTabId().value,
			epoch: 0,
			sessionId: record.getSessionIdString(),
			payload,
			legacy: false,
		}));
	}

	/** `message.error` is global UI (a toast), so every view shows it once. */
	private publishTabError(record: TabRecord, message: string): void {
		this.publishRecordEvent(record, 'message.error', { message });
	}

	/**
	 * Legacy target for the session's `window.<fn>` fallback.
	 *
	 * <p>Tab sessions always get a named event sink, so this target is never used
	 * for their data; it remains for single-session callers and for a handler
	 * that has not been migrated yet. There is deliberately no active-tab
	 * filtering here: dropping a background tab's event was the bug.</p>
	 */
	private createLegacyTarget(): JsTarget {
		return {
			callJavaScript: (fn, ...args) => this.broadcast(fn, ...args),
		};
	}

	/** 广播到所有存活视图（全局瞬时提示等非状态事件）。 */
	private broadcast(functionName: string, ...args: string[]): void {
		for (const channel of this.viewRegistry.allChannels()) {
			if (!channel.isDisposed()) {
				channel.callJavaScript(functionName, ...args);
			}
		}
	}

	private createSessionForTab(cwd: string, tabId: TabId): OpenCodeSession | null {
		const create = this.options.createSession;
		if (!create) {
			return null;
		}
		const session = create(
			this.createLegacyTarget(),
			() => {
				// per-tab 的「自动打开文件」开关（§10.12）：tab 自己设过就用它的，
				// 没设过（undefined）才回落到全局项目设置。
				const record = this.registry.get(tabId);
				return record ? record.getSettings().getAutoOpenFileOverride() : undefined;
			},
			() => {
				// 上下文注入开关：默认开；关闭后发送不再带活动文件/选区。
				const record = this.registry.get(tabId);
				return record ? record.getSettings().isContextEnabled() : true;
			},
			(event) => {
				// Named data plane: every session event is addressed to this tab
				// and goes through the per-tab lane scheduler.
				const record = this.registry.get(tabId);
				record?.getEventSink()(event);
			},
		);
		if (!session) {
			return null;
		}
		if (cwd) {
			session.state.setCwd(cwd);
		}
		this.options.configureSession?.(session);
		this.watchSessionBinding(tabId, session);
		return session;
	}

	/**
	 * 等服务端分配会话 id 后把 binding 写进 registry。
	 *
	 * 首次发送前 tab 处于「有会话、无 id」的 CREATING 态；id 由 opencode 在
	 * 第一轮 prompt 建立会话后下发，此时才成为可寻址的 canonical session。
	 */
	private watchSessionBinding(tabId: TabId, session: OpenCodeSession): void {
		this.bindingUnsubs.get(tabId.value)?.();

		const assigned = session.state.getSessionId();
		if (assigned) {
			this.bindTabSession(tabId, session, assigned);
		}

		const off = session.state.onSessionIdAssigned((sessionId) => {
			this.bindTabSession(tabId, session, sessionId);
		});
		this.bindingUnsubs.set(tabId.value, off);
	}

	private bindSessionSink(sessionId: string, session: OpenCodeSession): void {
		if (!sessionId || !session || !this.options.daemon) {
			return;
		}
		this.options.daemon.registerSessionSink(sessionId, {
			onLine: (line) => session.processLine(line),
		});
	}

	private unbindSessionSink(sessionId: string): void {
		if (!sessionId || !this.options.daemon) {
			return;
		}
		this.options.daemon.unregisterSessionSink(sessionId);
	}

	private bindTabSession(tabId: TabId, session: OpenCodeSession, sessionId: string): void {
		const record = this.registry.get(tabId);
		if (!record || record.isClosed() || record.getSession() !== session) {
			return;
		}
		const boundAdapter = record.getAdapter() ?? session.getAdapter();
		const boundCoalescer = record.getCoalescer() ?? session.getAdapter().getCoalescer();

		if (boundAdapter) {
			boundAdapter.setSessionId(sessionId);
			// 关键：stamp tabId，确保后续所有 session 事件（content.delta 等）都包含 tabId 走命名路由
			boundAdapter.setTabId(tabId.value);
		}
		if (boundCoalescer) {
			boundCoalescer.setSessionId(sessionId);
			boundCoalescer.setTabId(tabId.value);
		}

		const previousSessionId = record.getSessionIdString();
		if (previousSessionId && previousSessionId !== sessionId) {
			this.unbindSessionSink(previousSessionId);
			this.registry.release(tabId);
		}

		if (previousSessionId === sessionId) {
			return;
		}

		try {
			this.registry.bind(
				tabId,
				sessionId,
				session,
				boundAdapter,
				boundCoalescer,
			);
			this.bindSessionSink(sessionId, session);
			this.options.onSessionBound?.(tabId.value, sessionId);
			// 同步通知前端当前 tab 的 sessionId（如目录不匹配重置或新会话生成）
			this.publishRecordEvent(record, 'session.bound', { sessionId });
		} catch (err) {
			PluginFileLogger.warn(
				'ChatWindow',
				`failed to bind session ${sessionId} to tab ${tabId.value}: ${String(err)}`,
			);
		}
	}

	/**
	 * Bind a forked session to the tab the webview reserved for it.
	 *
	 * <p>The target tab is created before the fork returns, so the session is
	 * already owned when the webview's `session.fork.bound` handler asks to load
	 * it. The source tab is not touched.</p>
	 */
	private bindForkedSession(targetTabId: string, newSessionId: string): void {
		const tabId = TabId.of(targetTabId);
		const existing = this.registry.get(tabId);
		if (existing?.getSessionIdString()) {
			PluginFileLogger.info('ChatWindow', `fork target ${targetTabId} is already bound; ignoring`);
			return;
		}
		const cwd = existing?.getCwd() || this.fallbackWorkingDirectoryResolver() || '';
		try {
			const record = this.sessionFactory.attachSession(tabId, newSessionId, cwd, (session) => {
				if (cwd) {
					session.state.setCwd(cwd);
				}
				this.options.configureSession?.(session);
			});
			this.options.onSessionBound?.(targetTabId, newSessionId);
			PluginFileLogger.info('ChatWindow', `Fork bound: tab=${targetTabId}, ses=${newSessionId}`);
		} catch (err) {
			PluginFileLogger.warn(
				'ChatWindow',
				`failed to bind forked session ${newSessionId} to tab ${targetTabId}: ${String(err)}`,
			);
		}
	}

	/** 拿到（必要时创建）某个 tab 的会话。 */
	ensureTabSession(record: TabRecord): OpenCodeSession | null {
		const existing = record.getSession();
		if (existing) {
			return existing;
		}
		if (!this.options.createSession) {
			return null;
		}
		const cwd = record.getCwd() || this.fallbackWorkingDirectoryResolver() || '';
		const prepared = this.sessionFactory.prepare(record.getTabId(), cwd);
		return prepared.session;
	}

	/** 活跃 tab 的会话；没有 tab 或未装配会话工厂时返回 null（调动方回退单会话语义）。 */
	ensureActiveTabSession(): OpenCodeSession | null {
		const tabId = this.registry.getActiveTabId();
		if (!tabId) {
			return null;
		}
		const record = this.registry.get(tabId);
		return record ? this.ensureTabSession(record) : null;
	}

	/** INV-7：缺失身份被丢弃的次数（诊断面板/日志使用）。 */
	getUnattributedCount(): number {
		return this.unattributedCount;
	}

	/**
	 * daemon 意外退出/重启：所有进行中的 turn 都不可能再完成。
	 *
	 * <p>宿主会话状态先归零（replay 时不会再把 loading 带回来），活跃视图再收一次
	 * `onStreamEnd`，让前端立刻清掉流式指示；后台 tab 切回时由 replayTab 回放。</p>
	 */
	handleDaemonDied(): void {
		for (const record of this.registry.liveTabs()) {
			const session = record.getSession();
			if (!session) {
				continue;
			}
			session.state.setLoading(false);
			session.state.setBusy(false);
		}
		// Settle every tab, not just the one on screen: a background turn also
		// dies with the daemon, and its record must not keep a spinner forever.
		for (const record of this.registry.liveTabs()) {
			if (!record.getSession()) {
				continue;
			}
			this.publishRecordEvent(record, 'turn.ended', { reason: 'daemon_restart' });
		}
	}

	/**
	 * 把某个 tab 的状态回放到视图（切 tab / 视图重建）。
	 *
	 * 切 tab / 视图重建时，用该 tab 自己的 coalescer 冲刷一份快照，并补齐身份、
	 * loading、revert 与终态信号。全程命名事件，其他视图只会更新自己的 tab 记录。
	 */
	replayTab(record: TabRecord): void {
		const session = record.getSession();

		if (!session) {
			this.publishRecordEvent(record, 'session.cleared', { barrier: 0 });
			this.publishRecordEvent(record, 'session.bound', { sessionId: '' });
			this.publishRecordEvent(record, 'session.loading', { loading: false });
			this.publishRecordEvent(record, 'revert.changed', { state: JSON.stringify({ hasRevert: false }) });
			this.publishRecordEvent(record, 'session.loaded', {});
			return;
		}

		const state = session.state;
		const coalescer = record.getCoalescer() ?? session.getAdapter().getCoalescer();
		const barrier = coalescer.resetStreamState();
		this.publishRecordEvent(record, 'session.cleared', { barrier });
		coalescer.enqueue(state.getMessages(), state.getWindowBaseIndex());
		coalescer.flush();

		this.publishRecordEvent(record, 'session.bound', { sessionId: state.getSessionId() ?? '' });
		// 按 tab 的模型 / 权限模式 / 推理力度：切回该 tab 时选择器必须回到它自己的值，
		// 否则 A 的选择会被 B 覆盖（§10.4/§10.5/§10.6 的「A/B 独立」判据）。
		this.publishRecordEvent(record, 'tab.state', {
			state: JSON.stringify({
				model: state.getModel(),
				permissionMode: state.getPermissionMode(),
				reasoningEffort: state.getReasoningEffort(),
			}),
		});
		const turnStart = state.getActiveTurnStartTime();
		this.publishRecordEvent(record, 'session.loading', {
			loading: state.isLoading(),
			turnStartTime: turnStart ?? null,
		});
		const revert = state.getRevertState();
		this.publishRecordEvent(record, 'revert.changed', {
			state: JSON.stringify(revert ? { hasRevert: true, messageId: revert.messageID } : { hasRevert: false }),
		});
		this.publishRecordEvent(record, 'session.loaded', {});
	}

	/**
	 * 在活跃 tab 内换会话（新对话 / 切历史）。
	 *
	 * `sessionId === null` = 新对话；否则 = 绑到已有会话（`session.load` / 历史切换）。
	 * 两种情况都先释放本 tab 的旧绑定：`TabRegistry.bind` 在「已绑到别的会话」时会
	 * 抛错，不释放就只能回退成单会话语义（内容落到孤儿会话上，UI 什么都不显示）。
	 */
	switchActiveTabSession(sessionId: string | null): OpenCodeSession | null {
		const tabId = this.registry.getActiveTabId();
		if (!tabId) {
			return null;
		}
		const record = this.registry.get(tabId);
		if (!record || !this.options.createSession) {
			return null;
		}

		const previous = record.getSession();
		const previousSessionId = record.getSessionIdString();
		const cwd = record.getCwd() || this.fallbackWorkingDirectoryResolver() || '';

		if (sessionId) {
			if (previousSessionId && previousSessionId === sessionId) {
				// 已经就绑在这个会话上：不重建（重建会丢掉正在进行的流与状态）。
				return previous;
			}
			if (previousSessionId) {
				this.dropBinding(tabId);
			}
			try {
				const attached = this.sessionFactory.attachSession(tabId, sessionId, cwd);
				const session = attached.getSession();
				if (previous && previous !== session) {
					previous.dispose();
				}
				return session;
			} catch (err) {
				PluginFileLogger.warn('ChatWindow', `attach session failed: ${String(err)}`);
				return null;
			}
		}

		// 新对话：解除绑定后挂一个全新会话。
		this.dropBinding(tabId);
		const created = this.createSessionForTab(cwd, tabId);
		if (!created) {
			return null;
		}
		record.attachPendingSession(created, created.getAdapter(), created.getAdapter().getCoalescer());
		if (previous && previous !== created) {
			previous.dispose();
		}
		return created;
	}

	/** 释放本 tab 的会话绑定（保留 tab 本身）。 */
	private dropBinding(tabId: TabId): void {
		this.bindingUnsubs.get(tabId.value)?.();
		this.bindingUnsubs.delete(tabId.value);
		this.registry.release(tabId);
	}

	registerView(viewId: string, channel: WebviewChannel): ViewRecord {
		const record = this.viewRegistry.register(viewId, channel);
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

		// 视图重建后只有 tab 列表、没有消息：把活跃 tab 的状态补一遍，
		// 否则侧边栏隐藏再显示会得到「tab 在、内容是空」的状态。
		const active = this.registry.getActiveTabId();
		const record = active ? this.registry.get(active) : null;
		if (record) {
			this.replayTab(record);
		}
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
			// 视图重新挂载后目录可能已经变化（设置页新增 agent / 配置热载）。
			this.options.requestAgents?.();
			return;
		}

		// 视图切换（chat / history / settings）：宿主只做广播，页面状态由各视图自持。
		if (type === 'view.navigate') {
			const view = typeof command.payload.view === 'string' ? command.payload.view : '';
			if (!view) {return;}
			this.eventRouter.publish(
				new TabEvent({
					type: 'view.navigate',
					tabId: this.registry.getActiveTabId()?.value || '',
					epoch: 0,
					payload: { view, sourceViewId: viewId },
				}),
			);
			return;
		}

		// 窗口级命令：不针对任何 tab（导出/下载），必须在 tab 路由之前处理，
		// 否则会被当成「缺 tabId」直接拒掉。
		if (type === 'save_json') {
			const content = typeof command.payload.content === 'string' ? command.payload.content : '';
			const filename = typeof command.payload.filename === 'string' ? command.payload.filename : '';
			this.options.saveText?.(content, filename);
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

			const targetTabId = command.tabId ?? (
				WINDOW_SCOPED_COMMANDS.has(type) ? this.registry.getActiveTabId() : null
			);
			if (!targetTabId) {
				this.unattributedCount += 1;
				this.rejectCommand(
					viewId,
					'',
					command.requestId,
					CommandRejectCode.MISSING_TAB_ID,
					`Command ${type} requires a target tab`,
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

			const guardedPayload = SESSION_GUARDED_COMMANDS.has(type)
				&& command.sessionId
				&& typeof command.payload.sessionId !== 'string'
				? { ...command.payload, sessionId: command.sessionId.value }
				: command.payload;
			const tabCmd = TabCommand.of(targetTabId.value, type, command.requestId, guardedPayload);
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
