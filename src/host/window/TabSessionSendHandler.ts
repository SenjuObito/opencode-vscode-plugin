/**
 * TabSessionSendHandler — v2 `session.send` / `session.interrupt`。
 *
 * 与 legacy `SessionHandler` 的区别只有一点，但正是多 tab 的全部要求：
 * **目标会话由命令的 tabId 决定**，不看「当前活跃会话」。B 的发送不会落在 A 上，
 * 中断也只打自己那一轮。
 *
 * 会话按需创建：tab 第一次发送时才建 `OpenCodeSession`（`ensureSession`），
 * 服务端在第一轮 prompt 里分配 sessionId 后由 ChatWindow 写回 registry。
 */
import { TabCommand } from '../tab/TabCommand';
import { TabRecord } from '../tab/TabRecord';
import type { OpenCodeSession, SendMessagePayload } from '../session/OpenCodeSession';
import { normalizeSendPayload } from '../util/sendPayload';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface TabSessionSendHandlerOptions {
	/** 拿到（必要时创建）目标 tab 的会话。 */
	ensureSession: (record: TabRecord) => OpenCodeSession | null;
	/** 把该 tab 的宿主状态回放到视图（发送前对齐 cwd/model 等选择）。 */
	replay: (record: TabRecord) => void;
	/** 该 tab 的错误提示出口（命名事件：后台 tab 也会作为 toast 出现）。 */
	reportError: (record: TabRecord, message: string) => void;
	/**
	 * 把「已落盘的附件」读回成内联 base64（附件链路启用时注入）。
	 * 返回 null 表示该 id 不可用，此时上报错误而不是发一条缺附件消息。
	 */
	resolveAttachment?: (
		tabId: string,
		attachmentId: string,
	) => { data: string; fileName: string; mediaType: string } | null;
}

export class TabSessionSendHandler {
	constructor(private readonly options: TabSessionSendHandlerOptions) {}

	/** 按 tab 发送一条消息（或 `!` 开头的 shell 命令）。 */
	send(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}

		const payload = normalizeSendPayload(command.payload);
		const text = payload.text ?? '';
		if (text.trim().length === 0) {
			return;
		}

		const session = this.options.ensureSession(record);
		if (!session) {
			this.reportError(record, '会话尚未初始化，请重新打开面板。');
			return;
		}

		if (!this.inlineAttachments(record, payload)) {
			// 附件读不出来就不发：发出去只会得到一条缺图的提问。
			return;
		}

		this.applyTabSettings(record, session, command, payload);

		const cwd = record.getCwd() || undefined;
		if (text.startsWith('!') && text.trim().length > 1) {
			const shellCommand = text.slice(1).trim();
			session.sendShell(shellCommand, cwd).catch((ex: unknown) => {
				this.reportError(record, `Shell 执行失败: ${errorText(ex)}`);
			});
			return;
		}

		session.send(payload).catch((ex: unknown) => {
			this.reportError(record, `发送失败: ${errorText(ex)}`);
		});
	}

	/** 中断目标 tab 当前这一轮（只打自己）。 */
	interrupt(_command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		const session = record.getSession();
		if (!session) {
			return;
		}
		session.interrupt();
		PluginFileLogger.info('TabSessionSendHandler', `interrupt tab=${record.getTabId().value}`);
	}

	/**
	 * 把 tab 级设置写进会话状态。
	 *
	 * 命令里显式带来的值优先（webview 每次发送都会带当前选择），否则退回该 tab
	 * 已保存的设置——两者都缺时保持会话原有值，绝不读别的 tab。
	 */
	private applyTabSettings(
		record: TabRecord,
		session: OpenCodeSession,
		command: TabCommand,
		payload: SendMessagePayload,
	): void {
		const settings = record.getSettings();
		const state = session.state;

		const cwd = record.getCwd();
		if (cwd && cwd !== state.getCwd()) {
			state.setCwd(cwd);
		}

		const mode = command.string('permissionMode') ?? payload.permissionMode ?? settings.getPermissionMode();
		if (mode) {
			state.setPermissionMode(mode);
		}

		const effort = command.string('reasoningEffort') ?? payload.reasoningEffort ?? settings.getReasoningEffort();
		if (effort) {
			state.setReasoningEffort(effort);
		}
	}

	/**
	 * 把只带 attachmentId 的附件补成内联 base64。
	 *
	 * @returns false 表示有附件读不出来，本次发送应当放弃
	 */
	private inlineAttachments(record: TabRecord, payload: SendMessagePayload): boolean {
		const attachments = payload.attachments;
		if (!Array.isArray(attachments) || attachments.length === 0) {
			return true;
		}
		const resolve = this.options.resolveAttachment;
		if (!resolve) {
			return true;
		}

		for (const attachment of attachments) {
			const id = attachment.attachmentId;
			if (!id || attachment.data) {
				continue;
			}
			const resolved = resolve(record.getTabId().value, id);
			if (!resolved) {
				this.reportError(record, `附件不可用（${attachment.fileName ?? id}），请重新添加后再发送。`);
				return false;
			}
			attachment.data = resolved.data;
			attachment.fileName = attachment.fileName ?? resolved.fileName;
			attachment.mediaType = attachment.mediaType ?? resolved.mediaType;
		}
		return true;
	}

	private reportError(record: TabRecord, message: string): void {		PluginFileLogger.warn('TabSessionSendHandler', `tab=${record.getTabId().value} ${message}`);
		this.options.reportError(record, message);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
