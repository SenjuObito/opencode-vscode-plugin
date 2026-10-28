import { PromptKind } from './PromptKind';
import { PendingPrompt } from './PendingPrompt';

export interface PendingQuestionData {
	sessionId: string;
	questions: unknown;
	callId: string;
	directory: string;
}

export interface PromptFuture<T> {
	resolve: (val: T) => void;
	reject: (err: Error) => void;
	promise: Promise<T>;
}

function createFuture<T>(): PromptFuture<T> {
	let resolve!: (val: T) => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

/**
 * Owns every in-flight prompt and the session/tab it belongs to.
 * Ensures that closing a tab rejects exactly its prompts and leaves other tabs intact.
 */
export class PromptRegistry {
	readonly permissions = new Map<string, PromptFuture<number>>();
	readonly permissionSessions = new Map<string, string>();
	readonly permissionTabs = new Map<string, string>();

	readonly askFutures = new Map<string, PromptFuture<Record<string, unknown>>>();
	readonly askSessions = new Map<string, string>();
	readonly askTabs = new Map<string, string>();
	readonly questions = new Map<string, PendingQuestionData>();

	readonly planFutures = new Map<string, PromptFuture<Record<string, unknown>>>();
	readonly planSessions = new Map<string, string>();
	readonly planTabs = new Map<string, string>();

	createPermissionFuture(requestId: string, sessionId?: string, tabId?: string): Promise<number> {
		const future = createFuture<number>();
		this.permissions.set(requestId, future);
		if (sessionId) {
			this.permissionSessions.set(requestId, sessionId);
		}
		if (tabId) {
			this.permissionTabs.set(requestId, tabId);
		}
		return future.promise;
	}

	createAskFuture(
		requestId: string,
		sessionId?: string,
		tabId?: string,
		questionData?: PendingQuestionData,
	): Promise<Record<string, unknown>> {
		const future = createFuture<Record<string, unknown>>();
		this.askFutures.set(requestId, future);
		if (sessionId) {
			this.askSessions.set(requestId, sessionId);
		}
		if (tabId) {
			this.askTabs.set(requestId, tabId);
		}
		if (questionData) {
			this.questions.set(requestId, questionData);
		}
		return future.promise;
	}

	createPlanFuture(requestId: string, sessionId?: string, tabId?: string): Promise<Record<string, unknown>> {
		const future = createFuture<Record<string, unknown>>();
		this.planFutures.set(requestId, future);
		if (sessionId) {
			this.planSessions.set(requestId, sessionId);
		}
		if (tabId) {
			this.planTabs.set(requestId, tabId);
		}
		return future.promise;
	}

	rememberPermissionTab(requestId: string, tabId: string): void {
		if (requestId && tabId) {
			this.permissionTabs.set(requestId, tabId);
		}
	}

	rememberQuestionTab(requestId: string, tabId: string): void {
		if (requestId && tabId) {
			this.askTabs.set(requestId, tabId);
		}
	}

	rememberPlanTab(requestId: string, tabId: string): void {
		if (requestId && tabId) {
			this.planTabs.set(requestId, tabId);
		}
	}

	tabIdOf(requestId: string): string | null {
		if (!requestId) {return null;}
		return (
			this.permissionTabs.get(requestId) ||
			this.askTabs.get(requestId) ||
			this.planTabs.get(requestId) ||
			null
		);
	}

	sessionIdOf(requestId: string): string | null {
		if (!requestId) {return null;}
		return (
			this.permissionSessions.get(requestId) ||
			this.askSessions.get(requestId) ||
			this.planSessions.get(requestId) ||
			null
		);
	}

	pendingForTab(tabId: string): PendingPrompt[] {
		const result: PendingPrompt[] = [];
		if (!tabId) {return result;}

		for (const [requestId, tId] of this.permissionTabs.entries()) {
			if (tId === tabId) {
				result.push(
					new PendingPrompt(
						requestId,
						PromptKind.PERMISSION,
						this.permissionSessions.get(requestId) || null,
						tId,
					),
				);
			}
		}

		for (const [requestId, tId] of this.askTabs.entries()) {
			if (tId === tabId) {
				const q = this.questions.get(requestId);
				result.push(
					new PendingPrompt(
						requestId,
						PromptKind.QUESTION,
						this.askSessions.get(requestId) || null,
						tId,
						q?.callId ?? null,
						q?.directory ?? null,
						q?.questions ?? null,
					),
				);
			}
		}

		for (const [requestId, tId] of this.planTabs.entries()) {
			if (tId === tabId) {
				result.push(
					new PendingPrompt(
						requestId,
						PromptKind.PLAN,
						this.planSessions.get(requestId) || null,
						tId,
					),
				);
			}
		}

		return result;
	}

	/**
	 * Rejects all pending prompts for a tab when it is closed.
	 */
	rejectForTab(tabId: string): string[] {
		const rejected: string[] = [];
		if (!tabId) {return rejected;}

		for (const [requestId, tId] of Array.from(this.permissionTabs.entries())) {
			if (tId === tabId) {
				const future = this.permissions.get(requestId);
				this.permissions.delete(requestId);
				this.permissionSessions.delete(requestId);
				this.permissionTabs.delete(requestId);
				if (future) {
					future.reject(new Error(`tab closed: ${requestId}`));
				}
				rejected.push(requestId);
			}
		}

		for (const [requestId, tId] of Array.from(this.askTabs.entries())) {
			if (tId === tabId) {
				const future = this.askFutures.get(requestId);
				this.askFutures.delete(requestId);
				this.askSessions.delete(requestId);
				this.askTabs.delete(requestId);
				this.questions.delete(requestId);
				if (future) {
					future.reject(new Error(`tab closed: ${requestId}`));
				}
				rejected.push(requestId);
			}
		}

		for (const [requestId, tId] of Array.from(this.planTabs.entries())) {
			if (tId === tabId) {
				const future = this.planFutures.get(requestId);
				this.planFutures.delete(requestId);
				this.planSessions.delete(requestId);
				this.planTabs.delete(requestId);
				if (future) {
					future.reject(new Error(`tab closed: ${requestId}`));
				}
				rejected.push(requestId);
			}
		}

		return rejected;
	}

	pendingCount(): number {
		return this.permissions.size + this.askFutures.size + this.planFutures.size;
	}
}
