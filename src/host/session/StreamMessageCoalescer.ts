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
	private lastSnapshot: ChatMessage[] | null = null;
	private lastDeliveredSnapshot: ChatMessage[] | null = null;

	private updateTimer: NodeJS.Timeout | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;

	constructor(target: CoalescerTarget) {
		this.target = target;
	}

	enqueue(messages: ChatMessage[]): void {
		if (this.target.isDisposed()) {
			console.log('[StreamMessageCoalescer] enqueue BLOCKED: target disposed');
			return;
		}
		const snapshot = [...messages];
		this.pendingMessages = snapshot;
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
		this.lastSnapshot = null;
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
		this.pendingMessages = null;
		const sequence = ++this.updateSequence;

		if (snapshot == null) {
			afterFlushOnEdt?.(sequence);
			return;
		}
		this.sendToWebView(snapshot, sequence, afterFlushOnEdt);
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
			this.pendingMessages = null;
			const sequence = this.updateSequence;

			if (this.target.isDisposed()) {
				return;
			}
			if (snapshot != null) {
				this.sendToWebView(snapshot, sequence, undefined);
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
	): void {
		this.lastSnapshot = messages;
		console.log('[StreamMessageCoalescer] sendToWebView called, seq:', sequence, 'lastPushed:', this.lastPushedSequence, 'messages:', messages.length);

		const transport = selectMessageTransport(messages, this.lastDeliveredSnapshot);
		const tailUpdate = transport.tailUpdate;
		const tailBaseIndex = transport.baseIndex;
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
				this.target.callUpdateMessages('updateMessages', [json, String(sequence)]);
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
