/**
 * SessionHandler — port of cc-gui `handler/SessionHandler.java`.
 * Handles send_message / send_message_with_attachments / interrupt_session / restart_session.
 * opencode only: node-version gating is replaced by daemon availability gating.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { isValidPermissionMode } from '../session/SessionState';
import type { SendMessagePayload } from '../session/OpenCodeSession';
import { join as pathJoin, dirname, isAbsolute } from 'path';
import { homedir } from 'os';

const SUPPORTED_TYPES = ['send_message', 'send_message_with_attachments', 'interrupt_session', 'restart_session'];

/** JSON 文本安全转义（作为 JS 字符串字面量注入）。 */
function escapeJs(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
}

export class SessionHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'send_message':
				this.handleSendMessage(content);
				return true;
			case 'send_message_with_attachments':
				this.handleSendMessageWithAttachments(content);
				return true;
			case 'interrupt_session':
				this.handleInterruptSession();
				return true;
			case 'restart_session':
				this.handleRestartSession();
				return true;
			default:
				return false;
		}
	}

	/** VS Code 里 daemon 以 process.execPath 运行；无独立 node 版本门槛。 */
	private ensureDaemonReady(): boolean {
		return true;
	}

	private handleSendMessage(content: string): void {
		if (!this.ensureDaemonReady()) {
			return;
		}

		const payload = this.parsePayload(content);
		if (!payload) {
			return;
		}

		this.sendWithPayload(payload);
	}

	private handleSendMessageWithAttachments(content: string): void {
		if (!this.ensureDaemonReady()) {
			return;
		}

		let payload: SendMessagePayload;
		try {
			payload = this.parsePayload(content) ?? { text: '' };
		} catch {
			// 解析失败降级为普通文本
			this.handleSendMessage(content);
			return;
		}

		this.sendWithPayload(payload);
	}

	private parsePayload(content: string): SendMessagePayload | null {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const text = typeof parsed?.text === 'string' ? parsed.text : content;
			const payload: SendMessagePayload = { text };
			if (Array.isArray(parsed?.attachments)) {
				payload.attachments = (parsed.attachments as Array<Record<string, unknown>>).map((a) => ({
					fileName: typeof a?.fileName === 'string' ? a.fileName : undefined,
					mediaType: typeof a?.mediaType === 'string' ? a.mediaType : undefined,
					data: typeof a?.data === 'string' ? a.data : undefined,
				}));
			}
			if (Array.isArray(parsed?.fileTags)) {
				payload.fileTags = (parsed.fileTags as Array<Record<string, unknown>>)
					.filter((t) => t && typeof t === 'object')
					.map((t) => ({
						displayPath: typeof t.displayPath === 'string' ? t.displayPath : undefined,
						absolutePath: typeof t.absolutePath === 'string' ? t.absolutePath : undefined,
					}));
			}
			if (typeof parsed?.permissionMode === 'string' && isValidPermissionMode(parsed.permissionMode)) {
				payload.permissionMode = parsed.permissionMode;
			}
			if (typeof parsed?.reasoningEffort === 'string') {
				payload.reasoningEffort = parsed.reasoningEffort;
			}
			return payload;
		} catch {
			return { text: content };
		}
	}

	private sendWithPayload(payload: SendMessagePayload): void {
		const session = this.context.getSession();
		if (!session) {
			this.callJavaScript('addErrorMessage', escapeJs('会话尚未初始化，请重新打开面板。'));
			return;
		}

		const currentCwd = this.determineWorkingDirectory();
		const previousCwd = session.state.getCwd();
		if (currentCwd !== previousCwd) {
			session.state.setCwd(currentCwd);
		}

		// opencode 原生 `!` 语义：以 ! 开头的输入作为 shell 命令透传给
		// opencode 服务端（POST /session/{id}/shell），输出作为 bash 工具
		// 结果进入对话并触发 AI 回复。
		const text = payload.text ?? '';
		if (text.startsWith('!') && text.trim().length > 1) {
			const command = text.slice(1).trim();
			session.sendShell(command, currentCwd).catch((ex: unknown) => {
				const message = ex instanceof Error ? ex.message : String(ex);
				this.callJavaScript('addErrorMessage', escapeJs(`Shell 执行失败: ${message}`));
			});
			return;
		}

		session.send(payload).catch((ex: unknown) => {
			const message = ex instanceof Error ? ex.message : String(ex);
			this.callJavaScript('addErrorMessage', escapeJs(`发送失败: ${message}`));
		});
	}

	private handleInterruptSession(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		session.interrupt();
		// 中断后同步前端流结束状态
		this.callJavaScript('onStreamEnd', '-1');
		this.callJavaScript('showLoading', 'false');
	}

	private handleRestartSession(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}
		session.resetSession();
	}

	/**
	 * 确定工作目录（port of determineWorkingDirectory）：
	 * 1. 用户配置的有效 working directory（最高优先）
	 * 2. 首个 workspace 根
	 * 3. 活跃编辑器文件父目录（当文件不在 workspace 内时）
	 * 4. 用户主目录兜底
	 */
	private determineWorkingDirectory(): string {
		const configured = this.context.resolveEffectiveWorkingDirectory();
		if (configured && configured.trim() !== '') {
			return configured;
		}
		return this.context.getFallbackWorkingDirectory() ?? homedir();
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
