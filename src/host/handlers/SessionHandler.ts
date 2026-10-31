/**
 * SessionHandler — window-level v2 session commands, aligned with idea's
 * `handler/SessionHandler.java`.
 *
 * <p>`session.send` / `session.interrupt` / `session.restart` are not tab-router
 * commands. The envelope's `tabId` and `sessionId` are merged into the payload
 * by `HostCommand`; this handler resolves the owning tab's session through the
 * ChatWindow tab-session context. That is the same ownership model as idea:
 * the command names its target, the window dispatcher applies it.</p>
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { RequestIdDeduplicator } from '../router/HostCommand';
import type { TabSender } from './TabSender';
import type { OpenCodeSession, SendMessagePayload } from '../session/OpenCodeSession';
import { normalizeSendPayload } from '../util/sendPayload';
import { PluginFileLogger } from '../util/PluginFileLogger';
import { join as pathJoin, dirname, isAbsolute } from 'path';

const SUPPORTED_TYPES = ['session.send', 'session.interrupt', 'session.restart'];

interface SessionPayload extends SendMessagePayload {
	tabId?: string;
	sessionId?: string;
	requestId?: string;
}

export class SessionHandler extends BaseMessageHandler {
	private readonly requestIds = new RequestIdDeduplicator(2048);

	constructor(context: HandlerContext, private readonly sender: TabSender) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'session.send':
				this.handleSend(content);
				return true;
			case 'session.interrupt':
				this.handleInterrupt(content);
				return true;
			case 'session.restart':
				this.handleRestart(content);
				return true;
			default:
				return false;
		}
	}

	private parse(content: string): SessionPayload {
		try {
			const raw = JSON.parse(content) as Record<string, unknown>;
			if (!raw || typeof raw !== 'object') {
				return { text: content };
			}
			const payload = normalizeSendPayload(raw, content) as SessionPayload;
			payload.tabId = typeof raw.tabId === 'string' ? raw.tabId : undefined;
			payload.sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
			payload.requestId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
			return payload;
		} catch {
			return { text: content };
		}
	}

	private reject(tabId: string | null, requestId: string | null, code: string, message: string): void {
		PluginFileLogger.warn('SessionHandler', `${code} tab=${tabId ?? ''} request=${requestId ?? ''}: ${message}`);
		if (tabId) {
			this.context.publishTabEvent('command.rejected', tabId, {
				tabId,
				requestId: requestId ?? '',
				code,
				message,
			}, { legacy: false });
		}
	}

	private reportError(tabId: string, message: string): void {
		this.context.publishTabEvent('message.error', tabId, { message }, { legacy: false });
	}

	/** Interrupt/restart must never create a session just to stop one. */
	private resolveExistingSession(payload: SessionPayload, tabId: string): OpenCodeSession | null {		if (payload.sessionId) {
			return this.context.getSessionBySessionId(payload.sessionId) ?? this.context.getSessionForTab(tabId);
		}
		return this.context.getSessionForTab(tabId);
	}

	/**
	 * Forward one direct send to the shared tab sender.
	 *
	 * <p>Attachment materialization, per-tab settings and the tab/session
	 * ownership guard live in {@link TabSender} so the queue pump and this
	 * handler cannot drift.</p>
	 */
	private handleSend(content: string): void {
		const payload = this.parse(content);
		const tabId = payload.tabId?.trim() ?? '';
		const requestId = payload.requestId?.trim() ?? '';
		if (!tabId) {
			this.reject(null, requestId || null, 'MISSING_TAB_ID', 'the command must name the tab it belongs to');
			return;
		}
		if (!requestId) {
			this.reject(tabId, null, 'MISSING_REQUEST_ID', 'the command request id is required');
			return;
		}
		if (!this.requestIds.checkAndRecord(requestId)) {
			return;
		}
		if ((payload.text ?? '').trim().length === 0) {
			return;
		}

		const outcome = this.sender.send(tabId, payload, { requestId });
		if (!outcome.ok) {
			const code = outcome.code ?? 'SEND_FAILED';
			const message = outcome.message ?? 'send failed';
			this.reject(tabId, requestId, code, message);
			// The send never started, so the user also needs the inline error the
			// pre-sender implementation produced.
			this.reportError(tabId, message);
		}
	}

	private handleInterrupt(content: string): void {
		const payload = this.parse(content);
		const tabId = payload.tabId?.trim() ?? '';
		if (!tabId) {
			this.reject(null, payload.requestId ?? null, 'MISSING_TAB_ID', 'the command must name the tab it belongs to');
			return;
		}
		const session = this.resolveExistingSession(payload, tabId);
		if (!session) {
			return;
		}
		session.interrupt();
		// Stopping is an explicit decision: queued messages stay queued until
		// the user confirms (otherwise "stop" would immediately start the next
		// prompt).
		this.context.pauseTabQueue(tabId);
		this.context.publishTabEvent('turn.ended', tabId, {}, { legacy: false, sessionId: this.context.getSessionForTab(tabId)?.state.getSessionId() ?? tabId });
		this.context.publishTabEvent('session.loading', tabId, { loading: false }, { legacy: false });
		PluginFileLogger.info('SessionHandler', `interrupt tab=${tabId}`);
	}

	private handleRestart(content: string): void {
		const payload = this.parse(content);
		const tabId = payload.tabId?.trim() ?? '';
		if (!tabId) {
			this.reject(null, payload.requestId ?? null, 'MISSING_TAB_ID', 'the command must name the tab it belongs to');
			return;
		}
		const session = this.resolveExistingSession(payload, tabId);
		session?.resetSession();
	}
}

/** 供 determineWorkingDirectory 使用的外部文件路径工具。 */
export function isChildPath(childPath: string, basePath: string): boolean {
	if (!childPath || !basePath) {
		return false;
	}
	const absChild = pathJoin(isAbsolute(childPath) ? '' : process.cwd(), childPath);
	const absBase = pathJoin(isAbsolute(basePath) ? '' : process.cwd(), basePath);
	return absChild.startsWith(absBase);
}

export function parentDirOfFile(filePath: string): string | null {
	const d = dirname(filePath);
	return d === filePath ? null : d;
}
