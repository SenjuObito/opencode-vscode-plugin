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
}

export class SessionCallbackAdapter implements SessionCallback {
	private readonly streamCoalescer: StreamMessageCoalescer;
	private readonly jsTarget: JsTarget;
	private readonly permissionHandler?: (request: PermissionRequest) => void;
	private readonly permissionClosedHandler?: (kind: 'question' | 'permission', content: string) => void;
	private readonly streamEndCallback?: () => void;
	private readonly contentDeltaThrottler: StreamDeltaThrottler;
	private readonly thinkingDeltaThrottler: StreamDeltaThrottler;
	private readonly model: () => string | null;
	private active = true;
	private streamEndSignalSent = false;
	private streamEndFallbackTimer: NodeJS.Timeout | null = null;

	constructor(options: SessionCallbackAdapterOptions) {
		this.jsTarget = options.jsTarget;
		this.permissionHandler = options.permissionHandler;
		this.permissionClosedHandler = options.permissionClosedHandler;
		this.streamEndCallback = options.streamEndCallback;
		this.model = options.model;
		this.streamCoalescer = new StreamMessageCoalescer({
			callUpdateMessages: (fn, args) => this.jsTarget.callJavaScript(fn, ...args),
			callHeartbeat: () => this.jsTarget.callJavaScript('onStreamingHeartbeat'),
			isDisposed: () => this.isInactive(),
			pushUsageUpdate: (messages) => this.pushUsageFromMessages(messages),
			onStreamEnded: () => {
				/* 宿主可在流结束时做延迟工作 */
			},
		});
		this.contentDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				this.jsTarget.callJavaScript('onContentDelta', delta);
			}
		});
		this.thinkingDeltaThrottler = new StreamDeltaThrottler(DELTA_THROTTLE_MS, (delta) => {
			if (!this.isInactive()) {
				this.jsTarget.callJavaScript('onThinkingDelta', delta);
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

	// =========================================================================
	// SessionCallback
	// =========================================================================

	onMessageUpdate(messages: ChatMessage[]): void {
		if (!this.active) {
			console.log('[SessionCallbackAdapter] onMessageUpdate BLOCKED: adapter inactive');
			return;
		}
		console.log('[SessionCallbackAdapter] onMessageUpdate called, messages:', messages.length);
		this.streamCoalescer.enqueue(messages);
	}

	onStateChange(busy: boolean, loading: boolean, error: string | null): void {
		if (this.isInactive()) {
			return;
		}
		// 流式期间不下发 loading=false，状态清理统一由 onStreamEnd 处理。
		if (!loading && this.streamCoalescer.isStreamActive()) {
			return;
		}
		this.jsTarget.callJavaScript('showLoading', String(loading));
		if (error) {
			this.jsTarget.callJavaScript('updateStatus', `Error: ${error}`);
		}
	}

	onStatusMessage(message: string): void {
		if (this.isInactive() || !message || message.trim() === '') {
			return;
		}
		this.jsTarget.callJavaScript('updateStatus', message);
	}

	onSessionIdReceived(sessionId: string): void {
		if (this.isInactive()) {
			return;
		}
		this.jsTarget.callJavaScript('setSessionId', sessionId);
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
		this.jsTarget.callJavaScript('showThinkingStatus', String(isThinking));
	}

	onSummaryReceived(summary: string): void {
		if (this.isInactive() || !summary || summary.trim() === '') {
			return;
		}
		this.jsTarget.callJavaScript('showSummary', summary);
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
		this.jsTarget.callJavaScript('showLoading', 'true');
		this.jsTarget.callJavaScript('onStreamStart');
	}

	onStreamEnd(): void {
		if (this.isInactive()) {
			return;
		}
		this.streamEndSignalSent = false;
		this.safeRun('contentDeltaThrottler.flushNow', () => this.contentDeltaThrottler.flushNow());
		this.safeRun('thinkingDeltaThrottler.flushNow', () => this.thinkingDeltaThrottler.flushNow());
		this.safeRun('streamCoalescer.onStreamEnd', () => this.streamCoalescer.onStreamEnd());

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
		this.safeRun('callJavaScript(onStreamEnd)', () =>
			this.jsTarget.callJavaScript('onStreamEnd', String(sequence)),
		);
		this.safeRun('callJavaScript(showLoading, false)', () =>
			this.jsTarget.callJavaScript('showLoading', 'false'),
		);
		if (this.streamEndCallback) {
			this.safeRun('streamEndCallback', this.streamEndCallback);
		}
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
		this.jsTarget.callJavaScript('onBlockReset');
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
		this.jsTarget.callJavaScript('onUsageUpdate', json);
	}

	onUserMessageUuidPatched(content: string, uuid: string): void {
		if (this.isInactive()) {
			return;
		}
		this.jsTarget.callJavaScript('patchMessageUuid', content, uuid);
	}

	onTaskEvent(eventJson: string): void {
		if (this.isInactive() || !eventJson || eventJson.trim() === '') {
			return;
		}
		this.jsTarget.callJavaScript('onTaskEvent', eventJson);
	}

	onRevertStateUpdate(hasRevert: boolean): void {
		if (this.isInactive()) {
			return;
		}
		this.jsTarget.callJavaScript('onRevertStateUpdate', JSON.stringify({ hasRevert }));
	}

	onTodoUpdated(payload: string): void {
		console.log('[SessionCallbackAdapter] onTodoUpdated called, active:', this.active, 'payload length:', payload?.length);
		if (this.isInactive() || !payload) {
			console.log('[SessionCallbackAdapter] onTodoUpdated BLOCKED: inactive or empty payload');
			return;
		}
		console.log('[SessionCallbackAdapter] onTodoUpdated calling jsTarget.callJavaScript("onTodoUpdated")');
		this.jsTarget.callJavaScript('onTodoUpdated', payload);
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
		this.jsTarget.callJavaScript('onUsageUpdate', json);
	}
}
