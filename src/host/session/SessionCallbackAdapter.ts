/**
 * SessionCallbackAdapter — port of cc-gui `session/SessionCallbackAdapter.java`.
 * Routes SessionCallback events to webview `window.<fn>` calls: streaming
 * deltas via throttlers, structural updates via the coalescer, and lifecycle
 * signals (showLoading / onStreamEnd / setSessionId / …) directly.
 */
import { ChatMessage, PermissionRequest, SessionCallback } from './types';
import { StreamDeltaThrottler } from './StreamDeltaThrottler';
import { StreamMessageCoalescer } from './StreamMessageCoalescer';
import { buildUsageSnapshot } from '../util/MessageJsonConverter';

const DELTA_THROTTLE_MS = 33;
const STREAM_END_FALLBACK_MS = 300;

/** Webview 侧 `window.<fn>(...args)` 的调用目标。 */
export interface JsTarget {
	callJavaScript(functionName: string, ...args: string[]): void;
}

export interface SessionCallbackAdapterOptions {
	jsTarget: JsTarget;
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
	onSessionIdReceived?: (sessionId: string) => void;
}

export class SessionCallbackAdapter implements SessionCallback {
	private readonly options: SessionCallbackAdapterOptions;
	private readonly streamCoalescer: StreamMessageCoalescer;
	private readonly jsTarget: JsTarget;
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
	private sessionId: string | null = null;
	private unattributedSessionWarned = false;

	constructor(options: SessionCallbackAdapterOptions) {
		this.options = options;
		this.jsTarget = options.jsTarget;
		this.permissionHandler = options.permissionHandler;
		this.permissionClosedHandler = options.permissionClosedHandler;
		this.streamEndCallback = options.streamEndCallback;
		this.model = options.model;
		this.windowBaseIndex = options.windowBaseIndex ?? (() => 0);
		this.streamCoalescer = new StreamMessageCoalescer({
			callUpdateMessages: (fn, args) => this.jsTarget.callJavaScript(fn, ...args),
			callHeartbeat: (sessionId) => this.jsTarget.callJavaScript('onStreamingHeartbeat', sessionId ?? this.getTargetSessionId() ?? ''),
			isDisposed: () => this.isInactive(),
			pushUsageUpdate: (messages) => this.pushUsageFromMessages(messages),
			onStreamEnded: () => {
				/* 宿主可在流结束时做延迟工作 */
			},
		});
		this.contentDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				if (!this.hasIdentity()) {
					this.warnUnattributedOnce('content delta');
					return;
				}
				this.jsTarget.callJavaScript('onContentDelta', this.getTargetSessionId()!, delta);
			}
		});
		this.thinkingDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				if (!this.hasIdentity()) {
					this.warnUnattributedOnce('thinking delta');
					return;
				}
				this.jsTarget.callJavaScript('onThinkingDelta', this.getTargetSessionId()!, delta);
			}
		});
	}

	setSessionId(sessionId: string | null): void {
		this.sessionId = sessionId;
		this.streamCoalescer.setSessionId(sessionId);
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	private hasIdentity(): boolean {
		return typeof this.sessionId === 'string' && this.sessionId.trim() !== '';
	}

	private warnUnattributedOnce(what: string): void {
		if (!this.unattributedSessionWarned) {
			this.unattributedSessionWarned = true;
			console.warn(`[SessionCallbackAdapter] has no session identity; dropping ${what}`);
		}
	}

	private getTargetSessionId(): string | null {
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('session-scoped callback');
			return null;
		}
		return this.sessionId;
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

	// =========================================================================
	// SessionCallback
	// =========================================================================

	onMessageUpdate(messages: ChatMessage[]): void {
		if (!this.active) {
			console.log('[SessionCallbackAdapter] onMessageUpdate BLOCKED: adapter inactive');
			return;
		}
		console.log('[SessionCallbackAdapter] onMessageUpdate called, messages:', messages.length);
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
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('loading state');
			return;
		}
		this.jsTarget.callJavaScript('showLoading', this.getTargetSessionId()!, String(loading));
		if (error) {
			this.jsTarget.callJavaScript('updateStatus', this.getTargetSessionId()!, `Error: ${error}`);
		}
	}

	onStatusMessage(message: string): void {
		if (this.isInactive() || !message || message.trim() === '') {
			return;
		}
		if (!this.hasIdentity()) {
			if (!this.isInactive()) {
				this.warnUnattributedOnce('status message');
			}
			return;
		}
		this.jsTarget.callJavaScript('updateStatus', this.getTargetSessionId()!, message);
	}

	onRetryStatus(payload: string): void {
		if (this.isInactive() || !payload || payload.trim() === '') {
			return;
		}
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('retry status');
			return;
		}
		// 独立通道（不走 updateStatus）：重试提示要常驻并带可点击 action 链接，
		// 而 updateStatus 是转瞬即逝的 toast，渲染不了链接。
		this.jsTarget.callJavaScript('updateRetryStatus', this.getTargetSessionId()!, payload);
	}

	onTurnEnd(jsonContent: string): void {
		if (this.isInactive() || !jsonContent || !jsonContent.trim()) {
			return;
		}
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('turn terminal');
			return;
		}
		this.jsTarget.callJavaScript('onTurnEnd', this.getTargetSessionId()!, jsonContent);
	}

	onSessionIdReceived(sessionId: string): void {
		if (this.isInactive()) {
			return;
		}
		this.setSessionId(sessionId);
		this.options.onSessionIdReceived?.(sessionId);
		this.jsTarget.callJavaScript('setSessionId', sessionId);
	}

	onSessionTitleReceived(sessionId: string, title: string): void {
		if (this.isInactive() || !sessionId || !title) {
			return;
		}
		this.jsTarget.callJavaScript('updateSessionTitle', sessionId, title);
	}

	onPermissionRequested(request: PermissionRequest): void {
		if (this.isInactive()) {
			return;
		}
		this.permissionHandler?.(request);
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
		if (!this.hasIdentity()) {
			if (!this.isInactive()) {
				this.warnUnattributedOnce('thinking status');
			}
			return;
		}
		this.jsTarget.callJavaScript('showThinkingStatus', this.getTargetSessionId()!, String(isThinking));
	}

	onSummaryReceived(summary: string): void {
		if (this.isInactive() || !summary || summary.trim() === '') {
			return;
		}
		if (!this.hasIdentity()) {
			if (!this.isInactive()) {
				this.warnUnattributedOnce('summary');
			}
			return;
		}
		this.jsTarget.callJavaScript('showSummary', this.getTargetSessionId()!, summary);
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
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('stream start');
			return;
		}
		this.jsTarget.callJavaScript('showLoading', this.getTargetSessionId()!, 'true');
		this.jsTarget.callJavaScript('onStreamStart', this.getTargetSessionId()!);
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
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('onStreamEnd');
			return;
		}
		const targetSessionId = this.getTargetSessionId()!;
		this.safeRun('callJavaScript(onStreamEnd)', () =>
			this.jsTarget.callJavaScript('onStreamEnd', targetSessionId, String(sequence)),
		);
		this.safeRun('callJavaScript(showLoading, false)', () =>
			this.jsTarget.callJavaScript('showLoading', targetSessionId, 'false'),
		);
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

	onBlockReset(): void {
		if (this.isInactive()) {
			return;
		}
		this.contentDeltaThrottler.reset();
		this.thinkingDeltaThrottler.reset();
		if (!this.hasIdentity()) {
			this.warnUnattributedOnce('block reset');
			return;
		}
		this.jsTarget.callJavaScript('onBlockReset', this.getTargetSessionId()!);
	}

	onUsageUpdate(usedTokens: number, maxTokens: number): void {
		if (this.isInactive() || !this.hasIdentity()) {
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
		this.jsTarget.callJavaScript('onUsageUpdate', this.getTargetSessionId()!, json);
	}

	/**
	 * 清空用量环。切换模型后分母已失效，清掉比继续展示旧模型的额度更诚实。
	 *
	 * 只发 percentage：让前端把 retained 的 used/max 一并清掉，避免 tooltip 里
	 * 出现 "0 / 0" 这种无意义的分母（对应 cc-gui `clearUsageDisplay`）。
	 */
	clearUsage(): void {
		if (this.isInactive() || !this.hasIdentity()) {
			return;
		}
		this.jsTarget.callJavaScript('onUsageUpdate', this.getTargetSessionId()!, JSON.stringify({ percentage: 0 }));
	}

	onUserMessageUuidPatched(content: string, uuid: string): void {
		if (this.isInactive() || !this.hasIdentity()) {
			return;
		}
		this.jsTarget.callJavaScript('patchMessageUuid', this.getTargetSessionId()!, content, uuid);
	}

	onTaskEvent(eventJson: string): void {
		if (this.isInactive() || !eventJson || eventJson.trim() === '' || !this.hasIdentity()) {
			return;
		}
		this.jsTarget.callJavaScript('onTaskEvent', this.getTargetSessionId()!, eventJson);
	}

	onRevertStateUpdate(hasRevert: boolean, messageId: string | null = null): void {
		if (this.isInactive() || !this.hasIdentity()) {
			return;
		}
		// messageId 供 webview 定位切片边界；缺省为 null，webview 会退回兜底逻辑。
		this.jsTarget.callJavaScript('onRevertStateUpdate', this.getTargetSessionId()!, JSON.stringify({ hasRevert, messageId }));
	}

	/**
	 * 把服务端权威删除转发给 webview。
	 *
	 * payload 是 opencode 消息 id 的裸 JSON 数组，与 webview 的
	 * `onMessagesRemoved` 解析形状一致。必须在随后的 updateMessages 快照之前发出，
	 * 这样快照到达时 webview 的列表已经收缩到位 —— 否则其「收缩保护」会把刚删的
	 * 消息当成暂时性收缩抢救回来。
	 */
	onMessagesRemoved(messageIds: string[]): void {
		if (this.isInactive() || !messageIds || messageIds.length === 0 || !this.hasIdentity()) {
			return;
		}
		const ids = messageIds.filter((id) => typeof id === 'string' && id.length > 0);
		if (ids.length === 0) {
			return;
		}
		this.jsTarget.callJavaScript('onMessagesRemoved', this.getTargetSessionId()!, JSON.stringify(ids));
	}

	onTodoUpdated(payload: string): void {
		console.log('[SessionCallbackAdapter] onTodoUpdated called, active:', this.active, 'payload length:', payload?.length);
		if (this.isInactive() || !payload || !this.hasIdentity()) {
			console.log('[SessionCallbackAdapter] onTodoUpdated BLOCKED: inactive, empty payload, or no identity');
			return;
		}
		console.log('[SessionCallbackAdapter] onTodoUpdated calling jsTarget.callJavaScript("onTodoUpdated")');
		this.jsTarget.callJavaScript('onTodoUpdated', this.getTargetSessionId()!, payload);
	}

	// =========================================================================

	/** 每个 updateMessages 推送后兜底同步用量快照。 */
	private pushUsageFromMessages(messages: ChatMessage[]): void {
		if (this.isInactive() || !this.hasIdentity()) {
			return;
		}
		const snapshot = buildUsageSnapshot(messages, this.model(), 'opencode');
		if (!snapshot) {
			return;
		}
		const json = JSON.stringify(snapshot);
		this.jsTarget.callJavaScript('onUsageUpdate', this.getTargetSessionId()!, json);
	}
}
