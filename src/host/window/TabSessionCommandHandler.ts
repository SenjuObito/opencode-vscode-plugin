import { TabCommand } from '../tab/TabCommand';
import { TabEvent } from '../tab/TabEvent';
import { TabId } from '../tab/TabId';
import { TabRecord } from '../tab/TabRecord';
import { TabRegistry } from '../tab/TabRegistry';
import { TabEventRouter } from './TabEventRouter';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { extractJsonObjectFromRaw } from '../util/ListMessagesCollector';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface TabSessionCommandHandlerOptions {
	registry: TabRegistry;
	eventRouter: TabEventRouter;
	daemon: () => OpenCodeDaemonBridge | null;
	resolveCwd: () => string | undefined;
	/** Bind the forked session to the tab the webview reserved for it. */
	onForkBound?: (targetTabId: string, newSessionId: string) => void;
	/**
	 * Publish a result event. The window uses this to feed the queue: a queued
	 * command stays in flight until its own result passes the same choke point
	 * every other tab event uses.
	 */
	publishEvent?: (event: TabEvent) => void;
}

interface Target {
	record: TabRecord;
	sessionId: string;
	tabId: string;
}

interface RevertState {
	hasRevert: boolean;
	messageId: string | null;
}

/**
 * Tab-scoped session commands: fork, share/unshare, revert/unrevert and
 * compact. Ported from idea's `TabSessionCommandHandler`.
 *
 * <p>The tab that sent the command is the only owner. None of these methods
 * falls back to "the active tab", and every result names the source/target tab
 * and session so a late answer still lands on the conversation that asked for
 * it.</p>
 */
export class TabSessionCommandHandler {
	constructor(private readonly options: TabSessionCommandHandlerOptions) {}

	// ── Fork ────────────────────────────────────────────────────────────

	async fork(command: TabCommand): Promise<void> {
		const sourceTabId = command.tabId.value;
		const targetTabId = command.string('targetTabId');
		if (!targetTabId) {
			this.publishForkFailure(sourceTabId, null, 'the fork must name its target tab', command.requestId);
			return;
		}

		const sourceRecord = this.options.registry.get(command.tabId);
		const sourceSessionId = sourceRecord?.getSessionIdString();
		if (!sourceRecord || !sourceSessionId) {
			this.publishForkFailure(sourceTabId, sourceSessionId ?? null, 'the source tab has no session to fork', command.requestId);
			return;
		}

		const requested = command.string('messageId');
		const messageId = requested && requested !== 'full' ? requested : null;
		if (messageId) {
			this.withMessageId(sourceSessionId, messageId,
				(resolvedId) => this.requestFork(sourceSessionId, resolvedId, sourceTabId, targetTabId, command.requestId),
				(error) => this.publishForkFailure(sourceTabId, sourceSessionId, error, command.requestId));
			return;
		}
		this.requestFork(sourceSessionId, null, sourceTabId, targetTabId, command.requestId);
	}

	private requestFork(
		sourceSessionId: string,
		messageId: string | null,
		sourceTabId: string,
		targetTabId: string,
		requestId: string,
	): void {
		const params: Record<string, unknown> = {
			sessionId: sourceSessionId,
			directory: this.options.resolveCwd(),
		};
		if (messageId) {
			params.messageID = messageId;
		}

		this.request('fork', params, (success, chunks) => {
			if (!success) {
				this.publishForkFailure(sourceTabId, sourceSessionId, 'fork session failed', requestId);
				return;
			}
			const payload = extractJsonObjectFromRaw(chunks.join('\n'));
			const newSessionId = typeof payload?.newSessionId === 'string' ? payload.newSessionId : '';
			if (!newSessionId) {
				this.publishForkFailure(sourceTabId, sourceSessionId, 'fork returned no session id', requestId);
				return;
			}
			this.options.onForkBound?.(targetTabId, newSessionId);
			this.publish('session.fork.bound', targetTabId, newSessionId, {
				targetTabId,
				sessionId: newSessionId,
				sourceTabId,
				sourceSessionId,
				requestId,
			});
		}, (error) => this.publishForkFailure(sourceTabId, sourceSessionId, error, requestId));
	}

	private publishForkFailure(
		sourceTabId: string,
		sourceSessionId: string | null,
		error: string,
		requestId?: string,
	): void {
		this.publish('session.fork.failed', sourceTabId, sourceSessionId, { data: error, error, requestId });
	}

	// ── Share / unshare ──────────────────────────────────────────────────

	share(command: TabCommand): void {
		const target = this.resolve(command);
		if (!target) {
			this.publish('session.share.failed', command.tabId.value, null, {
				data: 'tab has no session',
				requestId: command.requestId,
			});
			return;
		}
		this.request('shareSession', this.sessionParams(target.sessionId), (success, chunks) => {
			if (!success) {
				this.publishShareFailure(target, 'share failed', command.requestId);
				return;
			}
			const url = extractShareUrl(extractJsonObjectFromRaw(chunks.join('\n')));
			if (!url) {
				this.publishShareFailure(target, 'share returned no url', command.requestId);
				return;
			}
			this.publish('session.share.done', target.tabId, target.sessionId, {
				data: url,
				url,
				requestId: command.requestId,
			});
		}, (error) => this.publishShareFailure(target, error, command.requestId));
	}

	unshare(command: TabCommand): void {
		const target = this.resolve(command);
		if (!target) {
			this.publish('session.unshare.failed', command.tabId.value, null, {
				data: 'tab has no session',
				requestId: command.requestId,
			});
			return;
		}
		this.request('unshareSession', this.sessionParams(target.sessionId), (success) => {
			if (!success) {
				this.publish('session.unshare.failed', target.tabId, target.sessionId, {
					data: 'unshare failed',
					requestId: command.requestId,
				});
				return;
			}
			this.publish('session.unshare.done', target.tabId, target.sessionId, {
				data: '',
				requestId: command.requestId,
			});
		}, (error) => this.publish('session.unshare.failed', target.tabId, target.sessionId, {
			data: error,
			requestId: command.requestId,
		}));
	}

	private publishShareFailure(target: Target, error: string, requestId?: string): void {
		this.publish('session.share.failed', target.tabId, target.sessionId, {
			data: error,
			error,
			requestId,
		});
	}

	// ── Revert / unrevert ────────────────────────────────────────────────

	revert(command: TabCommand): void {
		const target = this.resolve(command);
		if (!target) {
			this.publishRevertFailure(command.tabId.value, null, 'undo', 'tab has no session', command.requestId);
			return;
		}
		const requested = command.string('messageId') ?? command.string('messageID');
		this.withMessageId(target.sessionId, requested,
			(resolvedId) => {
				const params = this.sessionParams(target.sessionId);
				params.messageID = resolvedId;
				this.request('revert', params, (success, chunks) => {
					if (!success) {
						this.publishRevertFailure(target.tabId, target.sessionId, 'undo', 'revert failed', command.requestId);
						return;
					}
					const state = parseRevertState(extractJsonObjectFromRaw(chunks.join('\n')), resolvedId);
					target.record.getSession()?.state.setRevertState(
						state.hasRevert && state.messageId ? { messageID: state.messageId } : null,
					);
					this.publish('revert.changed', target.tabId, target.sessionId, {
						state: JSON.stringify(state),
						requestId: command.requestId,
					});
				}, (error) => this.publishRevertFailure(target.tabId, target.sessionId, 'undo', error, command.requestId));
			},
			(error) => this.publishRevertFailure(target.tabId, target.sessionId, 'undo', error, command.requestId));
	}

	unrevert(command: TabCommand): void {
		const target = this.resolve(command);
		if (!target) {
			this.publishRevertFailure(command.tabId.value, null, 'redo', 'tab has no session', command.requestId);
			return;
		}
		this.request('unrevert', this.sessionParams(target.sessionId), (success) => {
			if (!success) {
				this.publishRevertFailure(target.tabId, target.sessionId, 'redo', 'unrevert failed', command.requestId);
				return;
			}
			target.record.getSession()?.state.setRevertState(null);
			this.publish('revert.changed', target.tabId, target.sessionId, {
				state: JSON.stringify({ hasRevert: false, messageId: null }),
				requestId: command.requestId,
			});
		}, (error) => this.publishRevertFailure(target.tabId, target.sessionId, 'redo', error, command.requestId));
	}

	private publishRevertFailure(
		tabId: string,
		sessionId: string | null,
		op: 'undo' | 'redo',
		error: string,
		requestId?: string,
	): void {
		this.publish('session.revert.failed', tabId, sessionId, { op, error, data: error, requestId });
	}

	// ── Compact ──────────────────────────────────────────────────────────

	compact(command: TabCommand): void {
		const target = this.resolve(command);
		if (!target) {
			this.publish('session.compact.failed', command.tabId.value, null, {
				error: 'tab has no session',
				data: '',
				requestId: command.requestId,
			});
			return;
		}
		const params = this.sessionParams(target.sessionId);
		const model = command.string('model');
		if (model) {
			params.model = model.trim();
		}
		this.request('summarize', params, (success) => {
			if (!success) {
				this.publish('session.compact.failed', target.tabId, target.sessionId, {
					error: 'compact failed',
					data: target.sessionId,
					requestId: command.requestId,
				});
				return;
			}
			this.publish('session.compact.done', target.tabId, target.sessionId, {
				data: target.sessionId,
				sessionId: target.sessionId,
				requestId: command.requestId,
			});
		}, (error) => this.publish('session.compact.failed', target.tabId, target.sessionId, {
			error,
			data: target.sessionId,
			requestId: command.requestId,
		}));
	}

	// ── Shared plumbing ──────────────────────────────────────────────────

	private resolve(command: TabCommand): Target | null {
		const record = this.options.registry.get(command.tabId);
		const sessionId = record?.getSessionIdString();
		if (!record || !sessionId) {
			return null;
		}
		const requested = command.string('sessionId');
		if (requested && requested !== sessionId) {
			PluginFileLogger.warn(
				'TabSessionCommandHandler',
				`${command.type} names ${requested} but tab ${command.tabId.value} now holds ${sessionId}; refusing`,
			);
			return null;
		}
		return { record, sessionId, tabId: command.tabId.value };
	}

	/**
	 * Resolve "latest"/empty to the last user message id.
	 *
	 * <p>Ported from idea's `withMessageId`: only an explicit id is accepted
	 * locally. `latest` always asks the daemon, because a live user message may
	 * not carry an opencode id yet; searching the host transcript would fall
	 * back to an older history message and revert too much.</p>
	 */
	private withMessageId(
		sessionId: string,
		messageId: string | null,
		run: (resolvedId: string) => void,
		onError: (error: string) => void,
	): void {
		const trimmed = messageId?.trim() ?? '';
		if (trimmed && trimmed !== 'latest') {
			run(trimmed);
			return;
		}

		const params = this.sessionParams(sessionId);
		// 只取最后一条 user 消息：`type=user&order=desc&limit=1`。
		// 拉全量再在宿主里找最后一条既慢又会踩到服务端分页（默认 50 条里
		// 可能一条 user 都没有），把 fork/revert 的边界算错。
		this.request('listMessages', { ...params, type: 'user', order: 'desc', limit: 1 }, (success, chunks) => {
			if (!success) {
				onError('listMessages failed');
				return;
			}
			const resolved = latestUserIdFromChunks(chunks);
			if (resolved) {
				run(resolved);
			} else {
				onError('no user message found');
			}
		}, onError);
	}

	private sessionParams(sessionId: string): Record<string, unknown> {
		return { sessionId, directory: this.options.resolveCwd() };
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		onComplete: (success: boolean, chunks: string[]) => void,
		onError: (error: string) => void,
	): void {
		const daemon = this.options.daemon();
		if (!daemon || !daemon.isAlive()) {
			onError('daemon is not alive');
			return;
		}
		const chunks: string[] = [];
		let errorFired = false;
		void daemon.request(`opencode.${method}`, params, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				errorFired = true;
				PluginFileLogger.warn('TabSessionCommandHandler', `opencode.${method} failed: ${error}`);
				onError(error);
			},
			onComplete: (success) => {
				if (!success && errorFired) {
					return;
				}
				onComplete(success, chunks);
			},
		});
	}

	private publish(type: string, tabId: string, sessionId: string | null, payload: Record<string, unknown>): void {
		const record = this.options.registry.get(TabId.of(tabId));
		const event = new TabEvent({
			type,
			tabId,
			epoch: record?.epoch ?? 0,
			sessionId,
			payload,
			legacy: false,
		});
		if (this.options.publishEvent) {
			this.options.publishEvent(event);
			return;
		}
		this.options.eventRouter.publish(event);
	}
}

function latestUserIdFromChunks(chunks: string[]): string | null {
	let latest: string | null = null;
	for (const chunk of chunks) {
		for (const line of chunk.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
				continue;
			}
			try {
				const obj = JSON.parse(trimmed) as Record<string, unknown>;
				const entries = Array.isArray(obj.messages)
					? obj.messages
					: obj.messageEntry ? [obj.messageEntry] : [];
				for (const entry of entries) {
					if (!entry || typeof entry !== 'object') {
						continue;
					}
					const info = (entry as Record<string, unknown>).info;
					const source = info && typeof info === 'object' ? info as Record<string, unknown> : entry as Record<string, unknown>;
					const role = typeof source.role === 'string' ? source.role : '';
					if (role !== 'user') {
						continue;
					}
					const id = typeof source.id === 'string' ? source.id : '';
					if (id) {
						latest = id;
					}
				}
			} catch {
				// ignore diagnostic lines
			}
		}
	}
	return latest;
}

function parseRevertState(payload: Record<string, unknown> | null, fallbackMessageId: string): RevertState {
	const session = payload?.session && typeof payload.session === 'object'
		? payload.session as Record<string, unknown>
		: null;
	const revert = payload?.revert && typeof payload.revert === 'object'
		? payload.revert as Record<string, unknown>
		: session?.revert && typeof session.revert === 'object'
			? session.revert as Record<string, unknown>
			: null;
	const id = typeof revert?.messageID === 'string'
		? revert.messageID
		: typeof revert?.messageId === 'string'
			? revert.messageId
			: typeof revert?.id === 'string' ? revert.id : '';
	const messageId = id || fallbackMessageId || null;
	return { hasRevert: !!messageId, messageId };
}

function extractShareUrl(payload: Record<string, unknown> | null): string {
	if (!payload) {
		return '';
	}
	const direct = typeof payload.url === 'string' ? payload.url : '';
	if (direct) {
		return direct;
	}
	const share = payload.share && typeof payload.share === 'object'
		? payload.share as Record<string, unknown>
		: null;
	if (!share) {
		return '';
	}
	if (typeof share.url === 'string') {
		return share.url;
	}
	const nested = share.share && typeof share.share === 'object'
		? share.share as Record<string, unknown>
		: null;
	return nested && typeof nested.url === 'string' ? nested.url : '';
}
