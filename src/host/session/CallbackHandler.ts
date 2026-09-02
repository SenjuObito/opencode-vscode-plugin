/**
 * CallbackHandler — port of cc-gui `session/CallbackHandler.java`.
 * Thin dispatch layer to the session callback.
 */
import { ChatMessage, SessionCallback, PermissionRequest } from './types';

export class CallbackHandler {
	private callback: SessionCallback | null = null;

	setCallback(callback: SessionCallback): void {
		this.callback = callback;
	}

	notifyMessageUpdate(messages: ChatMessage[]): void {
		this.callback?.onMessageUpdate(messages);
	}

	notifyStateChange(busy: boolean, loading: boolean, error: string | null): void {
		this.callback?.onStateChange(busy, loading, error);
	}

	notifyStatusMessage(message: string): void {
		this.callback?.onStatusMessage?.(message);
	}

	notifySessionIdReceived(sessionId: string): void {
		this.callback?.onSessionIdReceived(sessionId);
	}

	notifyPermissionRequested(request: PermissionRequest): void {
		this.callback?.onPermissionRequested?.(request);
	}

	/** 服务端已答复/取消某个未决 prompt（question 或 permission），content 为 JSON。 */
	notifyPermissionClosed(kind: 'question' | 'permission', content: string): void {
		this.callback?.onPermissionClosed?.(kind, content);
	}

	notifyThinkingStatusChanged(isThinking: boolean): void {
		this.callback?.onThinkingStatusChanged(isThinking);
	}

	notifySlashCommandsReceived(commands: string[]): void {
		this.callback?.onSlashCommandsReceived?.(commands);
	}

	notifyNodeLog(log: string): void {
		this.callback?.onNodeLog?.(log);
	}

	notifySummaryReceived(summary: string): void {
		this.callback?.onSummaryReceived?.(summary);
	}

	notifyStreamStart(): void {
		this.callback?.onStreamStart();
	}

	notifyStreamEnd(): void {
		this.callback?.onStreamEnd();
	}

	notifyContentDelta(delta: string): void {
		this.callback?.onContentDelta(delta);
	}

	notifyThinkingDelta(delta: string): void {
		this.callback?.onThinkingDelta(delta);
	}

	notifyBlockReset(): void {
		this.callback?.onBlockReset();
	}

	notifyUsageUpdate(usedTokens: number, maxTokens: number): void {
		this.callback?.onUsageUpdate(usedTokens, maxTokens);
	}

	notifyUserMessageUuidPatched(content: string, uuid: string): void {
		this.callback?.onUserMessageUuidPatched(content, uuid);
	}

	notifyTaskEvent(eventJson: string): void {
		this.callback?.onTaskEvent?.(eventJson);
	}

	notifyRevertStateUpdate(hasRevert: boolean): void {
		this.callback?.onRevertStateUpdate?.(hasRevert);
	}

	notifyTodoUpdated(payload: string): void {
		console.log('[CallbackHandler] notifyTodoUpdated called, callback exists:', !!this.callback, 'onTodoUpdated exists:', !!this.callback?.onTodoUpdated);
		this.callback?.onTodoUpdated?.(payload);
	}
}
