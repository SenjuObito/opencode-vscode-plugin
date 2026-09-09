/**
 * StreamMessageCoalescer — port of cc-gui `session/StreamMessageCoalescer.java`.
 * Coalesces streaming message updates to throttle webview pushes.
 * Adaptive interval: during active streaming, scale the interval by payload size
 * (delta channel keeps text live; updateMessages carries structural blocks).
 */
import { ChatMessage } from './types';
import { convertMessagesToJson } from '../util/MessageJsonConverter';

const UPDATE_INTERVAL_MS = 50;
const STREAMING_MIN_INTERVAL_MS = 150;
const LARGE_PAYLOAD_THRESHOLD = 100_000;
const MEDIUM_INTERVAL_MS = 500;
const LARGE_INTERVAL_MS = 2_000;
const XLARGE_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const LONG_CONVERSATION_THRESHOLD = 300;
const LONG_CONVERSATION_TAIL_SIZE = 180;

export interface CoalescerTarget {
	/** 推 `updateMessages(json, seq)` 或 `updateMessageTail(json, baseIndex, seq)`。 */
	callUpdateMessages(fn: 'updateMessages' | 'updateMessageTail', args: string[]): void;
	/** 推 `onStreamingHeartbeat`。 */
	callHeartbeat(): void;
	isDisposed(): boolean;
	/** 消息快照推送后，把用量兜底推给前端。 */
	pushUsageUpdate(messages: ChatMessage[]): void;
	/** 流结束（turn 的流式段结束）时回调宿主。 */
	onStreamEnded?(): void;
}

interface MessageTransport {
	messages: ChatMessage[];
	baseIndex: number;
	tailUpdate: boolean;
}

export class StreamMessageCoalescer {
	private readonly target: CoalescerTarget;
	private streamActive = false;
	private updateScheduled = false;
	private lastUpdateAtMs = 0;
	private updateSequence = 0;
	private lastPayloadChars = 0;
	private lastPushedSequence = 0;
	private pendingMessages: ChatMessage[] | null = null;
	/** pendingMessages 对应的宿主窗口基址（全局索引，见 SessionState 窗口化）。 */
	private pendingBaseIndex = 0;
	private lastSnapshot: ChatMessage[] | null = null;
	private lastSnapshotBaseIndex = 0;
	private lastDeliveredSnapshot: ChatMessage[] | null = null;

	private updateTimer: NodeJS.Timeout | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;

	constructor(target: CoalescerTarget) {
		this.target = target;
	}

	enqueue(messages: ChatMessage[], baseIndex = 0): void {
		if (this.target.isDisposed()) {
			console.log('[StreamMessageCoalescer] enqueue BLOCKED: target disposed');
			return;
		}
		const snapshot = [...messages];
		this.pendingMessages = snapshot;
		this.pendingBaseIndex = baseIndex;
		console.log('[StreamMessageCoalescer] enqueue messages:', snapshot.length, 'streamActive:', this.streamActive);
		this.schedulePush();
		if (this.streamActive) {
			this.startHeartbeat();
		}
	}

	onStreamStart(): void {
		this.streamActive = true;
		this.startHeartbeat();
	}

	onStreamEnd(): void {
		this.clearHeartbeat();
		this.streamActive = false;
		this.lastPayloadChars = 0;
		// 流结束保留 pendingMessages：SessionCallbackAdapter.onStreamEnd 随后调
		// flush() 把它作为最终快照投递给 webview（先快照后 onStreamEnd 信号的
		// 顺序保证）。这里若清掉它，flush 只能回退到上一次已投递的旧快照 ——
		// 中断/异常收尾时最终内容会被旧数据覆盖（消息“消失”的根源之一）。
		// 定时推送若还挂着，取消它，让 flush 的全量投递成为流的最后一次推送。
		this.clearUpdate();
		this.updateScheduled = false;
		this.lastDeliveredSnapshot = null;
		this.target.onStreamEnded?.();
	}

	/**
	 * 重置流状态（如新建会话）。返回重置后的序列号作为屏障；旧会话已分发的
	 * 快照携带更小序列号，前端 `__minAcceptedUpdateSequence` 守卫会拒绝它们。
	 */
	resetStreamState(): number {
		this.clearUpdate();
		this.clearHeartbeat();
		this.streamActive = false;
		this.updateScheduled = false;
		this.pendingMessages = null;
		this.pendingBaseIndex = 0;
		this.lastSnapshot = null;
		this.lastSnapshotBaseIndex = 0;
		this.lastDeliveredSnapshot = null;
		this.lastUpdateAtMs = 0;
		this.lastPayloadChars = 0;
		this.lastPushedSequence = ++this.updateSequence;
		return this.lastPushedSequence;
	}

	isStreamActive(): boolean {
		return this.streamActive;
	}

	/** 立即冲刷挂起的消息，完成后可选执行回调（携带序列号）。 */
	flush(afterFlushOnEdt?: (sequence: number) => void): void {
		if (this.target.isDisposed()) {
			return;
		}
		this.clearUpdate();
		this.updateScheduled = false;
		const snapshot = this.pendingMessages ?? this.lastSnapshot;
		const baseIndex = this.pendingMessages != null ? this.pendingBaseIndex : this.lastSnapshotBaseIndex;
		this.pendingMessages = null;
		const sequence = ++this.updateSequence;

		if (snapshot == null) {
			afterFlushOnEdt?.(sequence);
			return;
		}
		this.sendToWebView(snapshot, sequence, afterFlushOnEdt, baseIndex);
	}

	dispose(): void {
		this.clearUpdate();
		this.clearHeartbeat();
	}

	// =========================================================================

	private effectiveIntervalMs(): number {
		if (!this.streamActive) {
			return UPDATE_INTERVAL_MS;
		}
		const chars = this.lastPayloadChars;
		if (chars > 500_000) {
			return XLARGE_INTERVAL_MS;
		}
		if (chars > 200_000) {
			return LARGE_INTERVAL_MS;
		}
		if (chars > LARGE_PAYLOAD_THRESHOLD) {
			return MEDIUM_INTERVAL_MS;
		}
		return STREAMING_MIN_INTERVAL_MS;
	}

	private schedulePush(): void {
		if (this.target.isDisposed()) {
			return;
		}
		if (this.updateScheduled) {
			return;
		}
		const intervalMs = this.effectiveIntervalMs();
		const elapsed = Date.now() - this.lastUpdateAtMs;
		const delayMs = Math.max(0, intervalMs - elapsed);
		this.updateScheduled = true;
		++this.updateSequence;

		this.updateTimer = setTimeout(() => {
			this.updateTimer = null;
			this.updateScheduled = false;
			this.lastUpdateAtMs = Date.now();
			const snapshot = this.pendingMessages;
			const baseIndex = this.pendingBaseIndex;
			this.pendingMessages = null;
			const sequence = this.updateSequence;

			if (this.target.isDisposed()) {
				return;
			}
			if (snapshot != null) {
				this.sendToWebView(snapshot, sequence, undefined, baseIndex);
			}
			if (this.pendingMessages != null && !this.target.isDisposed()) {
				this.schedulePush();
			}
		}, delayMs);
	}

	private sendToWebView(
		messages: ChatMessage[],
		sequence: number,
		afterSendOnEdt?: (sequence: number) => void,
		baseIndex = 0,
	): void {
		this.lastSnapshot = messages;
		this.lastSnapshotBaseIndex = baseIndex;
		console.log('[StreamMessageCoalescer] sendToWebView called, seq:', sequence, 'lastPushed:', this.lastPushedSequence, 'messages:', messages.length, 'baseIndex:', baseIndex);

		const transport = selectMessageTransport(messages, this.lastDeliveredSnapshot);
		const tailUpdate = transport.tailUpdate;
		// 尾部增量的 baseIndex 一律使用全局序号（窗口基址 + 局部偏移），
		// webview 据此对齐自己的列表窗口。
		const tailBaseIndex = baseIndex + transport.baseIndex;
		const transportMessages = transport.messages;

		let json: string;
		try {
			json = convertMessagesToJson(transportMessages);
			this.lastPayloadChars = json.length;
		} catch (err) {
			console.warn(`[StreamMessageCoalescer] Failed to serialize: ${(err as Error).message}`);
			afterSendOnEdt?.(sequence);
			return;
		}

		if (this.target.isDisposed()) {
			afterSendOnEdt?.(sequence);
			return;
		}

		// 丢弃真正乱序的帧：大载荷延迟送达的旧帧不得把列表回滚。
		if (sequence < this.lastPushedSequence) {
			console.log('[StreamMessageCoalescer] sendToWebView DROPPED: seq', sequence, '< lastPushed', this.lastPushedSequence);
			afterSendOnEdt?.(sequence);
			return;
		}
		this.lastPushedSequence = sequence;
		console.log('[StreamMessageCoalescer] sendToWebView SENDING: seq', sequence, 'tailUpdate:', tailUpdate);

		try {
			if (tailUpdate) {
				this.target.callUpdateMessages('updateMessageTail', [json, String(tailBaseIndex), String(sequence)]);
			} else {
				// 全量快照现在承载的是宿主「窗口」而非完整历史，第三个参数
				// 把窗口基址（全局序号）告知 webview，webview 侧据此做窗口
				// 精确替换/合并（缺省视为 0，兼容旧语义）。
				this.target.callUpdateMessages('updateMessages', [json, String(sequence), String(baseIndex)]);
			}
			this.lastDeliveredSnapshot = messages;
			this.target.pushUsageUpdate(messages);
		} catch (err) {
			console.warn(`[StreamMessageCoalescer] Failed to push updateMessages: ${(err as Error).message}`);
		}

		afterSendOnEdt?.(sequence);
	}

	// ===== 流式心跳 =====

	private startHeartbeat(): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setTimeout(() => {
			this.heartbeatTimer = null;
			if (!this.streamActive || this.target.isDisposed()) {
				return;
			}
			try {
				this.target.callHeartbeat();
			} catch {
				// 忽略心跳失败
			}
			this.startHeartbeat();
		}, HEARTBEAT_INTERVAL_MS);
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private clearUpdate(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
			this.updateTimer = null;
		}
	}
}

function selectMessageTransport(
	messages: ChatMessage[],
	previousMessages: ChatMessage[] | null,
): MessageTransport {
	const longConversation = messages.length > LONG_CONVERSATION_THRESHOLD;
	const candidateBaseIndex = longConversation
		? Math.max(0, messages.length - LONG_CONVERSATION_TAIL_SIZE)
		: 0;
	const stablePrefix =
		previousMessages != null &&
		messages.length >= previousMessages.length &&
		hasSamePrefix(previousMessages, messages, candidateBaseIndex);
	const tailUpdate = longConversation && stablePrefix;
	const baseIndex = tailUpdate ? candidateBaseIndex : 0;
	const transportMessages = tailUpdate ? messages.slice(baseIndex) : messages;
	return { messages: transportMessages, baseIndex, tailUpdate };
}

function hasSamePrefix(
	previousMessages: ChatMessage[],
	messages: ChatMessage[],
	prefixLength: number,
): boolean {
	if (previousMessages.length < prefixLength) {
		return false;
	}
	for (let i = 0; i < prefixLength; i++) {
		if (previousMessages[i] !== messages[i]) {
			return false;
		}
	}
	return true;
}
