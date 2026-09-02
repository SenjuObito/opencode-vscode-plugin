/**
 * ContextHandler — port of cc-gui `handler/ContextHandler.java`.
 * get_context_usage → daemon `opencode.getContextUsage` → showContextUsageDialog.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['get_context_usage'];

export class ContextHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (type !== 'get_context_usage') {
			return false;
		}
		void this.handleGetContextUsage(content);
		return true;
	}

	private async handleGetContextUsage(content: string): Promise<void> {
		let sessionId: string | null = null;
		let cwd: string | null = null;
		let model: string | null = null;
		let requestId: string | null = null;
		try {
			if (content && content.trim() !== '') {
				const request = JSON.parse(content) as Record<string, unknown>;
				sessionId = typeof request?.sessionId === 'string' ? request.sessionId : null;
				cwd = typeof request?.cwd === 'string' ? request.cwd : null;
				model = typeof request?.model === 'string' ? request.model : null;
				requestId = typeof request?.requestId === 'string' ? request.requestId : null;
			}
		} catch {
			// 解析失败用 session 兜底
		}

		const session = this.context.getSession();
		if (!session) {
			this.callContextUsageError('No active session', requestId);
			return;
		}
		if (!sessionId) {
			sessionId = session.state.getSessionId();
		}
		if (!cwd) {
			cwd = session.state.getCwd();
		}

		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.callContextUsageError('Daemon not ready', requestId);
			return;
		}

		const chunks: string[] = [];
		const ok = await daemon.request(
			'opencode.getContextUsage',
			{ sessionId: sessionId ?? undefined, cwd: cwd ?? undefined, model: model ?? undefined },
			{
				onLine: (line) => chunks.push(line),
				onError: (error) => this.callContextUsageError(error, requestId),
				onComplete: (success) => {
					if (!success) {
						return;
					}
					try {
						let response: Record<string, unknown> | null = null;
						for (let i = chunks.length - 1; i >= 0; i--) {
							const line = chunks[i].trim();
							if (!line.startsWith('{') || !line.endsWith('}')) {
								continue;
							}
							try {
								response = JSON.parse(line) as Record<string, unknown>;
								break;
							} catch {
								// 跳过
							}
						}
						if (!response) {
							this.callContextUsageError('Failed to get context usage', requestId);
							return;
						}
						if (response.success === false) {
							const err = typeof response.error === 'string' ? response.error : 'Failed to get context usage';
							this.callContextUsageError(err, requestId);
							return;
						}
						if (requestId) {
							response.requestId = requestId;
						}
						this.callJavaScript('showContextUsageDialog', JSON.stringify(response));
					} catch (err) {
						this.callContextUsageError(`Failed to process context usage data: ${String(err)}`, requestId);
					}
				},
			},
		);
		if (!ok) {
			this.callContextUsageError('Daemon unavailable for context usage', requestId);
		}
	}

	private callContextUsageError(message: string, requestId: string | null): void {
		if (requestId) {
			this.callJavaScript('onContextUsageError', message, requestId);
			return;
		}
		this.callJavaScript('onContextUsageError', message);
	}
}
