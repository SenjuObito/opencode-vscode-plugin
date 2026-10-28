/**
 * protocol.ts
 *
 * OpenCode Buddy 统一强类型通信协议定义。
 * 规范 Webview 与 IDE 宿主之间的出站请求（Webview -> Host）与入站通知（Host -> Webview）。
 */

/** Webview -> Host 支持的核心请求类型 */
export const BridgeMessageType = {
	// 会话与对话
	SEND_MESSAGE: 'send_message',
	SEND_MESSAGE_WITH_ATTACHMENTS: 'send_message_with_attachments',
	INTERRUPT_SESSION: 'interrupt_session',
	RESTART_SESSION: 'restart_session',

	// 历史与回退
	LOAD_HISTORY_DATA: 'load_history_data',
	LOAD_SESSION: 'load_session',
	DELETE_SESSION: 'delete_session',
	DELETE_SESSIONS: 'delete_sessions',
	TOGGLE_FAVORITE: 'toggle_favorite',
	UPDATE_TITLE: 'update_title',
	UNDO_MESSAGE: 'undo_message',

	// 模型与配置
	GET_CLI_MODELS: 'get_cli_models',
	GET_MODELS: 'get_models',
	SET_MODEL: 'set_model',
	GET_SETTINGS: 'get_settings',
	SAVE_SETTINGS: 'save_settings',

	// 文件与 IDE 原生操作
	OPEN_FILE: 'open_file',
	RESOLVE_FILE_PATH: 'resolve_file_path',
	OPEN_BROWSER: 'open_browser',
	SHOW_DIFF: 'show_diff',
	SHOW_EDITABLE_DIFF: 'show_editable_diff',
	UNDO_FILE_CHANGES: 'undo_file_changes',

	// 权限
	PERMISSION_REPLY: 'permission_reply',
	QUESTION_REPLY: 'question_reply',

	// 调试日志
	CARD_DEBUG: 'cardDebug',
} as const;

export type BridgeMessageType = typeof BridgeMessageType[keyof typeof BridgeMessageType];

/** 打开文件载荷 */
export interface OpenFilePayload {
	path: string;
	lineStart?: number;
	lineEnd?: number;
}

/** 显示差异载荷 */
export interface ShowDiffPayload {
	filePath: string;
	oldContent: string;
	newContent: string;
	title?: string;
}

/** 历史会话加载载荷 */
export interface LoadHistoryPayload {
	page?: number;
	pageSize?: number;
	keyword?: string;
}

/** 模型切换载荷 */
export interface SetModelPayload {
	modelId: string;
	provider?: string;
}

/** 权限应答载荷 */
export interface PermissionReplyPayload {
	requestId: string;
	decision: 'allow' | 'deny';
	scope?: 'once' | 'session' | 'always';
}

/** 安全解析 JSON 或纯文本 payload 工具函数 */
export function safeParseJson<T>(content: string, fallback: T): T {
	if (!content || typeof content !== 'string') {
		return fallback;
	}
	try {
		return JSON.parse(content) as T;
	} catch {
		return fallback;
	}
}
