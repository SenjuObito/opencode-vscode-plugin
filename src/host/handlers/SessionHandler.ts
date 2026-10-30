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
import { isValidPermissionMode } from '../session/SessionState';
import type { OpenCodeSession, SendMessagePayload } from '../session/OpenCodeSession';
import { normalizeSendPayload } from '../util/sendPayload';
import { PluginFileLogger } from '../util/PluginFileLogger';
import { join as pathJoin, dirname, isAbsolute } from 'path';
import { homedir } from 'os';

const SUPPORTED_TYPES = ['session.send', 'session.interrupt', 'session.restart'];

interface SessionPayload extends SendMessagePayload {
	tabId?: string;
	sessionId?: string;
	requestId?: string;
}

/** JSON text safe for the legacy JS fallback (RPC bridge strings). */
function escapeJs(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
}

export class SessionHandler extends BaseMessageHandler {
	private readonly requestIds = new RequestIdDeduplicator(2048);

	constructor(context: HandlerContext) {
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
		PluginFileLogger.warn('SessionHandler', `tab=${tabId} ${message}`);
		if (!this.context.publishTabEvent('message.error', tabId, { message }, { legacy: false })) {
			this.callJavaScript('addErrorMessage', escapeJs(message));
		}
	}

	/** Resolve the session named by the payload without falling back to active. */
	private resolveSession(payload: SessionPayload, tabId: string): OpenCodeSession | null {
		if (payload.sessionId) {
			const byId = this.context.getSessionBySessionId(payload.sessionId);
			if (byId) {
				return byId;
			}
		}
		return this.context.getSessionForTab(tabId) ?? this.context.createSessionForTab(tabId);
	}

	/** Interrupt/restart must never create a session just to stop one. */
	private resolveExistingSession(payload: SessionPayload, tabId: string): OpenCodeSession | null {
		if (payload.sessionId) {
			return this.context.getSessionBySessionId(payload.sessionId) ?? this.context.getSessionForTab(tabId);
		}
		return this.context.getSessionForTab(tabId);
	}

	private sessionMismatch(payload: SessionPayload, session: OpenCodeSession | null): string | null {
		if (!payload.sessionId || !session) {
			return null;
		}
		const bound = session.state.getSessionId();
		if (!bound) {
			return null;
		}
		return bound === payload.sessionId ? null : `tab is bound to ${bound}`;
	}

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

		const session = this.resolveSession(payload, tabId);
		if (!session) {
			this.reject(tabId, requestId, 'TAB_NOT_FOUND', `tab ${tabId} has no session`);
			return;
		}
		const mismatch = this.sessionMismatch(payload, session);
		if (mismatch) {
			this.reject(tabId, requestId, 'SESSION_MISMATCH', mismatch);
			return;
		}
		if (!this.inlineAttachments(payload, tabId)) {
			return;
		}

		this.applyTabSettings(payload, tabId, session);

		const text = payload.text ?? '';
		const cwd = this.context.getCwdForTab(tabId) ?? this.determineWorkingDirectory();
		if (text.startsWith('!') && text.trim().length > 1) {
			const command = text.slice(1).trim();
			session.sendShell(command, cwd).catch((ex: unknown) => {
				this.reportError(tabId, `Shell 执行失败: ${errorText(ex)}`);
			});
			return;
		}

		session.send(payload).catch((ex: unknown) => {
			this.reportError(tabId, `发送失败: ${errorText(ex)}`);
		});
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

	private applyTabSettings(payload: SendMessagePayload, tabId: string, session: OpenCodeSession): void {
		const settings = this.context.getSendSettings(tabId);
		const state = session.state;
		const cwd = this.context.getCwdForTab(tabId);
		if (cwd && cwd !== state.getCwd()) {
			state.setCwd(cwd);
		}

		const mode = payload.permissionMode ?? settings?.permissionMode ?? null;
		if (mode && isValidPermissionMode(mode)) {
			state.setPermissionMode(mode);
		}

		const model = payload.model ?? settings?.model ?? null;
		if (model && model !== state.getModel()) {
			state.setModel(model);
			session.republishUsageAfterModelChange();
		}

		const effort = payload.reasoningEffort ?? settings?.reasoningEffort ?? null;
		if (effort) {
			state.setReasoningEffort(effort);
		}
	}

	/** Materialize tab-staged attachments; a missing one aborts the send. */
	private inlineAttachments(payload: SendMessagePayload, tabId: string): boolean {
		const attachments = payload.attachments;
		if (!Array.isArray(attachments) || attachments.length === 0) {
			return true;
		}
		for (const attachment of attachments) {
			const id = attachment.attachmentId;
			if (!id || attachment.data) {
				continue;
			}
			const resolved = this.context.resolveAttachment(tabId, id);
			if (!resolved) {
				this.reportError(tabId, `附件不可用（${attachment.fileName ?? id}），请重新添加后再发送。`);
				return false;
			}
			attachment.data = resolved.data;
			attachment.fileName = attachment.fileName ?? resolved.fileName;
			attachment.mediaType = attachment.mediaType ?? resolved.mediaType;
		}
		return true;
	}

	private determineWorkingDirectory(): string {
		const configured = this.context.resolveEffectiveWorkingDirectory();
		if (configured && configured.trim() !== '') {
			return configured;
		}
		return this.context.getFallbackWorkingDirectory() ?? homedir();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
