/**
 * TabSender — the single sending path for one tab.
 *
 * <p>Both the webview's direct `session.send` (SessionHandler) and the tab
 * queue pump call this. Keeping attachment materialization, per-tab settings
 * and the ownership guard in one place means a queued send cannot drift from
 * a direct one, and a send that names another tab's session is refused instead
 * of silently landing in the wrong conversation.</p>
 */
import { HandlerContext } from '../router/HandlerContext';
import { isValidPermissionMode } from '../session/SessionState';
import type { OpenCodeSession, SendMessagePayload } from '../session/OpenCodeSession';
import { PluginFileLogger } from '../util/PluginFileLogger';
import { homedir } from 'os';

export interface TabSendPayload extends SendMessagePayload {
	sessionId?: string;
}

export interface TabSendOutcome {
	ok: boolean;
	/** Present when `ok` is false: a message the user must see. */
	message?: string;
	/** Reject code for protocol-level refusals (SESSION_MISMATCH, ...). */
	code?: string;
}

export class TabSender {
	constructor(private readonly context: HandlerContext) {}

	/**
	 * Send a payload as the tab that owns it.
	 *
	 * <p>Returns as soon as the turn was accepted by the session; the turn
	 * itself settles later (`turn.settled`). The caller must not await the
	 * whole turn — that would block the tab's actor for its duration.</p>
	 */
	send(tabId: string, payload: TabSendPayload, options?: { requestId?: string }): TabSendOutcome {
		const requestId = options?.requestId ?? null;
		if (!tabId) {
			return { ok: false, code: 'MISSING_TAB_ID', message: 'the command must name the tab it belongs to' };
		}

		const owner = payload.sessionId
			? this.context.getTabIdForSession(payload.sessionId)
			: null;
		if (payload.sessionId && owner && owner !== tabId) {
			const message = `session ${payload.sessionId} belongs to tab ${owner}, not ${tabId}`;
			PluginFileLogger.warn('TabSender', `SESSION_MISMATCH request=${requestId ?? ''} ${message}`);
			return { ok: false, code: 'SESSION_MISMATCH', message };
		}

		const session = this.resolveSession(payload, tabId);
		if (!session) {
			return { ok: false, code: 'TAB_NOT_FOUND', message: `tab ${tabId} has no session` };
		}

		const mismatch = this.sessionMismatch(payload, session);
		if (mismatch) {
			return { ok: false, code: 'SESSION_MISMATCH', message: mismatch };
		}
		if (!this.inlineAttachments(payload, tabId)) {
			return {
				ok: false,
				code: 'ATTACHMENT_UNAVAILABLE',
				message: '附件不可用，请重新添加后再发送。',
			};
		}

		this.applyTabSettings(payload, tabId, session);

		const text = payload.text ?? '';
		const cwd = this.context.getCwdForTab(tabId) ?? this.determineWorkingDirectory();
		if (text.startsWith('!') && text.trim().length > 1) {
			const command = text.slice(1).trim();
			session.sendShell(command, cwd).catch((ex: unknown) => {
				this.reportError(tabId, `Shell 执行失败: ${errorText(ex)}`);
			});
			return { ok: true };
		}

		session.send(payload).catch((ex: unknown) => {
			this.reportError(tabId, `发送失败: ${errorText(ex)}`);
		});
		return { ok: true };
	}

	private resolveSession(payload: TabSendPayload, tabId: string): OpenCodeSession | null {
		if (payload.sessionId) {
			const byId = this.context.getSessionBySessionId(payload.sessionId);
			if (byId) {
				return byId;
			}
		}
		return this.context.getSessionForTab(tabId) ?? this.context.createSessionForTab(tabId);
	}

	private sessionMismatch(payload: TabSendPayload, session: OpenCodeSession): string | null {
		if (!payload.sessionId) {
			return null;
		}
		const bound = session.state.getSessionId();
		if (!bound) {
			return null;
		}
		return bound === payload.sessionId ? null : `tab is bound to ${bound}`;
	}

	private applyTabSettings(payload: TabSendPayload, tabId: string, session: OpenCodeSession): void {
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
	private inlineAttachments(payload: TabSendPayload, tabId: string): boolean {
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
				return false;
			}
			attachment.data = resolved.data;
			attachment.fileName = attachment.fileName ?? resolved.fileName;
			attachment.mediaType = attachment.mediaType ?? resolved.mediaType;
		}
		return true;
	}

	private reportError(tabId: string, message: string): void {
		PluginFileLogger.warn('TabSender', `tab=${tabId} ${message}`);
		this.context.publishTabEvent('message.error', tabId, { message }, { legacy: false });
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
