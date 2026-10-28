import { PromptKind } from './PromptKind';

/**
 * A prompt waiting for a user decision / answer.
 * Identity is (tabId, requestId).
 */
export class PendingPrompt {
	constructor(
		readonly requestId: string,
		readonly kind: PromptKind,
		readonly sessionId: string | null,
		readonly tabId: string,
		readonly toolName: string | null = null,
		readonly directory: string | null = null,
		readonly questions: unknown = null,
	) {}
}
