/**
 * SessionCallbackAdapter — the per-tab data plane.
 *
 * <p>Ported from idea's `SessionCallbackAdapter.java`: every session-level
 * callback becomes a named `TabEvent` carrying `tabId`/`sessionId`/`turnId`/
 * `seq`, so the webview can route it to exactly one tab. The legacy
 * `window.<fn>` call remains only for the no-tab/single-session path; when a
 * tab exists the named path is the only one used for migrated data events.</p>
 */
import { ChatMessage, PermissionRequest, SessionCallback } from './types';
import { StreamDeltaThrottler } from './StreamDeltaThrottler';
import { StreamMessageCoalescer } from './StreamMessageCoalescer';
import { buildUsageSnapshot } from '../util/MessageJsonConverter';
import { TabEvent, TabEventSink } from '../tab/TabEvent';

const DELTA_THROTTLE_MS = 33;
const STREAM_END_FALLBACK_MS = 300;

/** Webview 侧 `window.<fn>(...args)` 的调用目标（legacy fallback）。 */
export interface JsTarget {
	callJavaScript(functionName: string, ...args: string[]): void;
}

export interface SessionCallbackAdapterOptions {
	jsTarget: JsTarget;
	/**
	 * Named event sink of the owning tab. When present (and the adapter knows
	 * its tab), data events travel as named events instead of `window.<fn>`.
	 */
	eventSink?: TabEventSink;
	/** 给权限请求的实际处理（Phase 4 接 webview 弹层）。 */
	permissionHandler?: (request: PermissionRequest) => void;
	/** 服务端已答复/取消未决 prompt（同步关闭 webview 卡片）。 */
	permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	/** 流结束时的额外回调（如重载会话标题）。 */
	streamEndCallback?: () => void;
	isDisposed?: () => boolean;
	model: () => string | null;
	/** 宿主消息窗口基址（全局序号，见 SessionState 窗口化），随快照下发给 webview。 */
	windowBaseIndex?: () => number;
}

export class SessionCallbackAdapter implements SessionCallback {
	private readonly streamCoalescer: StreamMessageCoalescer;
	private readonly jsTarget: JsTarget;
	private readonly eventSink?: TabEventSink;
	private readonly permissionHandler?: (request: PermissionRequest) => void;
	private readonly permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	private readonly streamEndCallback?: () => void;
	private readonly contentDeltaThrottler: StreamDeltaThrottler;
	private readonly thinkingDeltaThrottler: StreamDeltaThrottler;
	private readonly model: () => string | null;
	private readonly windowBaseIndex: () => number;
	private active = true;
	private streamEndSignalSent = false;
	private streamEndFallbackTimer: NodeJS.Timeout | null = null;
	private tabId: string | null = null;
	private sessionId: string | null = null;
	private turnCounter = 0;
	private activeTurnId: number | null = null;

	setTabId(tabId: string | null): void {
		this.tabId = tabId;
		this.streamCoalescer.setTabId(tabId);
	}

	getTabId(): string | null {
		return this.tabId;
	}

	setSessionId(sessionId: string | null): void {
		this.sessionId = sessionId;
		this.streamCoalescer.setSessionId(sessionId);
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	/**
	 * 本 adapter 自持的合并器。
	 *
	 * 多 tab 装配需要把它登记到 `TabRecord`（切 tab 回放时直接用它冲刷快照，
	 * 从而复用同一套序列号/窗口语义），因此必须暴露。
	 */
	getCoalescer(): StreamMessageCoalescer {
		return this.streamCoalescer;
	}

	constructor(options: SessionCallbackAdapterOptions) {
		this.jsTarget = options.jsTarget;
		this.eventSink = options.eventSink;
		this.permissionHandler = options.permissionHandler;
		this.permissionClosedHandler = options.permissionClosedHandler;
		this.streamEndCallback = options.streamEndCallback;
		this.model = options.model;
		this.windowBaseIndex = options.windowBaseIndex ?? (() => 0);
		this.streamCoalescer = new StreamMessageCoalescer(
			{
				callUpdateMessages: (fn, args) => this.jsTarget.callJavaScript(fn, ...args),
				callHeartbeat: () => this.jsTarget.callJavaScript('onStreamingHeartbeat'),
				isDisposed: () => this.isInactive(),
				pushUsageUpdate: (messages) => this.pushUsageFromMessages(messages),
				onStreamEnded: () => {
					/* 宿主可在流结束时做延迟工作 */
				},
			},
			options.eventSink,
		);
		this.contentDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				this.emit('content.delta', { delta }, () => this.jsTarget.callJavaScript('onContentDelta', delta));
			}
		});
		this.thinkingDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				this.emit('thinking.delta', { delta }, () => this.jsTarget.callJavaScript('onThinkingDelta', delta));
			}
		});
	}

	get coalescer(): StreamMessageCoalescer {
		return this.streamCoalescer;
	}

	deactivate(): void {
		this.active = false;
		this.contentDeltaThrottler.dispose();
		this.thinkingDeltaThrottler.dispose();
		this.cancelStreamEndFallback();
	}

	dispose(): void {
		this.deactivate();
	}

	private isInactive(): boolean {
		return !this.active;
	}

	private safeRun(label: string, action: () => void): void {
		try {
			action();
		} catch (err) {
			console.warn(`[SessionCallbackAdapter] ${label} failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Publish a named event when this adapter has a tab, otherwise run the
	 * legacy bridge call. This is the only place where the decision is made.
	 */
	private emit(
		type: string,
		payload: Record<string, unknown>,
		legacy?: () => void,
		extras?: { seq?: number | null; turnId?: number | null },
	): void {
		if (this.tabId && this.eventSink) {
			this.eventSink(new TabEvent({
				type,
				tabId: this.tabId,
				// The registry stamps the current epoch before routing.
				epoch: 0,
				sessionId: this.sessionId,
				turnId: extras?.turnId ?? this.activeTurnId,
				seq: extras?.seq ?? null,
				payload,
				legacy: false,
			}));
			return;
		}
		legacy?.();
	}

	// =========================================================================
	// SessionCallback
	// =========================================================================

	onMessageUpdate(messages: ChatMessage[]): void {
		if (!this.active) {
			console.log('[SessionCallbackAdapter] onMessageUpdate BLOCKED: adapter inactive');
			return;
		}
		this.streamCoalescer.enqueue(messages, this.windowBaseIndex());
	}

	onStateChange(busy: boolean, loading: boolean, error: string | null): void {
		if (this.isInactive()) {
			return;
		}
		// 流式期间不下发 loading=false，状态清理统一由 onStreamEnd 处理。
		if (!loading && this.streamCoalescer.isStreamActive()) {
			return;
		}
		this.emit('session.loading', { loading }, () => {
			this.jsTarget.callJavaScript('showLoading', String(loading));
		});
		if (error) {
			this.emit('turn.error', { error }, () => {
				this.jsTarget.callJavaScript('updateStatus', `Error: ${error}`);
			});
		}
	}

	onStatusMessage(message: string): void {
		if (this.isInactive() || !message || message.trim() === '') {
			return;
		}
		this.emit('status.updated', { status: message }, () => {
			this.jsTarget.callJavaScript('updateStatus', message);
		});
	}

	onRetryStatus(payload: string): void {
		if (this.isInactive() || !payload || payload.trim() === '') {
			return;
		}
		// 独立通道（不走 updateStatus）：重试提示要常驻并带可点击 action 链接。
		this.emit('turn.retry', { retry: payload }, () => {
			this.jsTarget.callJavaScript('updateRetryStatus', payload);
		});
	}

	onSessionIdReceived(sessionId: string): void {
		if (this.isInactive()) {
			return;
		}
		const previousSessionId = this.sessionId;
		this.setSessionId(sessionId);
		this.emit('session.bound', { sessionId, previousSessionId }, () => {
			this.jsTarget.callJavaScript('setSessionId', sessionId);
		});
	}

	onSessionTitleReceived(sessionId: string, title: string): void {
		if (!sessionId || !title) {
			return;
		}
		if (!this.sessionId) {
			this.sessionId = sessionId;
		}
		// Titles are addressed by session, not by adapter liveness: a tab switch
		// must not lose the title that arrives during the switch.
		this.emit('tab.title.changed', { title, sessionId }, () => {
			this.jsTarget.callJavaScript('updateSessionTitle', sessionId, title);
		});
	}

	onPermissionRequested(request: PermissionRequest): void {
		if (this.isInactive()) {
			return;
		}
		// 归属由 adapter 盖章：请求本身不带 tab/session，宿主去猜就会把后台 tab
		// 的弹窗算到当前活跃会话头上。
		this.permissionHandler?.({
			...request,
			sessionId: request.sessionId ?? this.sessionId ?? undefined,
			tabId: request.tabId ?? this.tabId ?? undefined,
		});
	}

	onPermissionClosed(kind: 'question' | 'permission', content: string): void {
		if (this.isInactive()) {
			return;
		}
		this.permissionClosedHandler?.(kind, content);
	}

	onThinkingStatusChanged(isThinking: boolean): void {
		if (this.isInactive()) {
			return;
		}
		this.emit('thinking.status', { thinking: isThinking }, () => {
			this.jsTarget.callJavaScript('showThinkingStatus', String(isThinking));
		});
	}

	onSummaryReceived(summary: string): void {
		if (this.isInactive() || !summary || summary.trim() === '') {
			return;
		}
		this.emit('session.summary', { summary }, () => {
			this.jsTarget.callJavaScript('showSummary', summary);
		});
	}

	// ===== 流式回调 =====

	onStreamStart(): void {
		if (this.isInactive()) {
			return;
		}
		this.cancelStreamEndFallback();
		this.contentDeltaThrottler.reset();
		this.thinkingDeltaThrottler.reset();
		this.streamCoalescer.onStreamStart();
		this.activeTurnId = ++this.turnCounter;
		this.emit('session.loading', { loading: true }, () => {
			this.jsTarget.callJavaScript('showLoading', 'true');
		});
		this.emit('turn.started', {}, () => {
			this.jsTarget.callJavaScript('onStreamStart');
		});
	}

	onStreamEnd(): void {
		if (!this.active) {
			return;
		}
		this.streamEndSignalSent = false;
		this.safeRun('contentDeltaThrottler.flushNow', () => this.contentDeltaThrottler.flushNow());
		this.safeRun('thinkingDeltaThrottler.flushNow', () => this.thinkingDeltaThrottler.flushNow());
		this.safeRun('streamCoalescer.onStreamEnd', () => this.streamCoalescer.onStreamEnd());

		// 触发宿主侧 Turn 结束回调（收敛 busy/loading 状态与会话生命周期）
		if (this.streamEndCallback) {
			this.safeRun('streamEndCallback', this.streamEndCallback);
		}

		// ── onStreamEnd 双路径 ──
		// 主路径：在 flush 回调里按顺序发，保证前端先收到最终快照再收到流结束信号。
		// 兜底路径：300ms 定时器，覆盖 flush 异步链路静默失败的场景。
		// 前端 onStreamEnd 幂等，双信号只生效第一个。
		this.streamCoalescer.flush((sequence) => {
			if (this.streamEndSignalSent) {
				return;
			}
			this.streamEndSignalSent = true;
			this.cancelStreamEndFallback();
			this.sendStreamEndToFrontend(sequence);
		});

		this.cancelStreamEndFallback();
		this.streamEndFallbackTimer = setTimeout(() => {
			this.streamEndFallbackTimer = null;
			if (this.streamEndSignalSent || this.isInactive()) {
				return;
			}
			this.streamEndSignalSent = true;
			console.warn('Stream end signal delivered via fallback (primary flush callback did not fire within 300ms)');
			this.sendStreamEndToFrontend(-1);
		}, STREAM_END_FALLBACK_MS);
	}

	private sendStreamEndToFrontend(sequence: number): void {
		if (this.isInactive()) {
			return;
		}
		const turnId = this.activeTurnId ?? undefined;
		this.emit('turn.ended', { sequence }, () => {
			this.jsTarget.callJavaScript('onStreamEnd', String(sequence));
		}, { seq: sequence });
		this.emit('session.loading', { loading: false }, () => {
			this.jsTarget.callJavaScript('showLoading', 'false');
		});
		this.emit('turn.settled', { terminal: JSON.stringify({ turnId }) }, () => {
			this.jsTarget.callJavaScript('onTurnEnd', JSON.stringify({ turnId }));
		});
		this.activeTurnId = null;
	}

	onTurnEnd(jsonContent: string): void {
		if (this.isInactive() || !jsonContent || jsonContent.trim() === '') {
			return;
		}
		this.emit('turn.settled', { terminal: jsonContent }, () => {
			this.jsTarget.callJavaScript('onTurnEnd', jsonContent);
		});
	}

	private cancelStreamEndFallback(): void {
		if (this.streamEndFallbackTimer) {
			clearTimeout(this.streamEndFallbackTimer);
			this.streamEndFallbackTimer = null;
		}
	}

	onContentDelta(delta: string): void {
		if (this.isInactive()) {
			return;
		}
		this.contentDeltaThrottler.append(delta);
	}

	onThinkingDelta(delta: string): void {
		if (this.isInactive()) {
			return;
		}
		this.thinkingDeltaThrottler.append(delta);
	}

	/** Host-initiated clear (new chat / history restore); named for tab routing. */
	notifyMessagesCleared(barrier: number): void {
		this.emit('session.cleared', { barrier }, () => {
			this.jsTarget.callJavaScript('clearMessages', String(barrier));
		});
	}

	onBlockReset(): void {
		if (this.isInactive()) {
			return;
		}
		this.contentDeltaThrottler.reset();
		this.thinkingDeltaThrottler.reset();
		this.emit('message.block.reset', {}, () => {
			this.jsTarget.callJavaScript('onBlockReset');
		});
	}

	onUsageUpdate(usedTokens: number, maxTokens: number): void {
		if (this.isInactive()) {
			return;
		}
		const safeUsed = Math.max(0, usedTokens);
		const safeMax = Math.max(0, maxTokens);
		const percentage = safeMax > 0 ? Math.min(100, Math.max(0, (safeUsed * 100) / safeMax)) : 0;
		const json = JSON.stringify({
			percentage,
			usedTokens: safeUsed,
			maxTokens: safeMax,
		});
		this.emit('usage.updated', { usage: json }, () => {
			this.jsTarget.callJavaScript('onUsageUpdate', json);
		});
	}

	/**
	 * 清空用量环。切换模型后分母已失效，清掉比继续展示旧模型的额度更诚实。
	 *
	 * 只发 percentage：让前端把 retained 的 used/max 一并清掉，避免 tooltip 里
	 * 出现 "0 / 0" 这种无意义的分母（对应 cc-gui `clearUsageDisplay`）。
	 */
	clearUsage(): void {
		if (this.isInactive()) {
			return;
		}
		const json = JSON.stringify({ percentage: 0 });
		this.emit('usage.updated', { usage: json }, () => {
			this.jsTarget.callJavaScript('onUsageUpdate', json);
		});
	}

	onUserMessageUuidPatched(content: string, uuid: string): void {
		if (this.isInactive()) {
			return;
		}
		this.emit('message.uuid.patched', { content, uuid }, () => {
			this.jsTarget.callJavaScript('patchMessageUuid', content, uuid);
		});
	}

	onTaskEvent(eventJson: string): void {
		if (this.isInactive() || !eventJson || eventJson.trim() === '') {
			return;
		}
		// 补会话归属：多 tab 后同一个 webview 只有一份面板状态，后台 tab 的
		// task 事件若不打标就会混进活跃 tab 的子代理列表。
		let payload = eventJson;
		if (this.sessionId) {
			try {
				const parsed = JSON.parse(eventJson) as Record<string, unknown>;
				if (parsed && typeof parsed === 'object' && !('sessionId' in parsed)) {
					payload = JSON.stringify({ ...parsed, sessionId: this.sessionId });
				}
			} catch {
				// 非 JSON 载荷原样转发，前端会自行丢弃
			}
		}
		this.emit('task.event', { event: payload }, () => {
			this.jsTarget.callJavaScript('onTaskEvent', payload);
		});
	}

	onRevertStateUpdate(hasRevert: boolean, messageId: string | null = null): void {
		if (this.isInactive()) {
			return;
		}
		const json = JSON.stringify({ hasRevert, messageId });
		this.emit('revert.changed', { state: json }, () => {
			this.jsTarget.callJavaScript('onRevertStateUpdate', json);
		});
	}

	/**
	 * 把服务端权威删除转发给 webview。
	 */
	onMessagesRemoved(messageIds: string[]): void {
		if (this.isInactive() || !messageIds || messageIds.length === 0) {
			return;
		}
		const ids = messageIds.filter((id) => typeof id === 'string' && id.length > 0);
		if (ids.length === 0) {
			return;
		}
		const json = JSON.stringify(ids);
		this.emit('message.removed', { ids: json }, () => {
			this.jsTarget.callJavaScript('onMessagesRemoved', json);
		});
	}

	onTodoUpdated(payload: string): void {
		if (this.isInactive() || !payload) {
			return;
		}
		this.emit('todos.updated', { todos: payload }, () => {
			this.jsTarget.callJavaScript('onTodoUpdated', payload);
		});
	}

	// =========================================================================

	/** 每个 updateMessages 推送后兜底同步用量快照。 */
	private pushUsageFromMessages(messages: ChatMessage[]): void {
		if (this.isInactive()) {
			return;
		}
		const snapshot = buildUsageSnapshot(messages, this.model(), 'opencode');
		if (!snapshot) {
			return;
		}
		const json = JSON.stringify(snapshot);
		this.emit('usage.updated', { usage: json }, () => {
			this.jsTarget.callJavaScript('onUsageUpdate', json);
		});
	}
}
