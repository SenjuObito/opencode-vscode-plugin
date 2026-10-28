/**
 * 发送载荷归一化。
 *
 * 两条发送路径共用：
 *   - legacy `send_message` / `send_message_with_attachments`（`SessionHandler`，内容是一段 JSON 文本）
 *   - v2 `session.send`（`TabSessionSendHandler`，payload 已经是对象）
 *
 * 归一化只接受字符串字段与白名单枚举，别把任意 JSON 直接递给会话层。
 */
import { isValidPermissionMode } from '../session/SessionState';
import type { SendMessagePayload } from '../session/OpenCodeSession';

export function normalizeSendPayload(
	raw: Record<string, unknown> | null | undefined,
	fallbackText = '',
): SendMessagePayload {
	const text = typeof raw?.text === 'string' ? raw.text : fallbackText;
	const payload: SendMessagePayload = { text };

	if (Array.isArray(raw?.attachments)) {
		payload.attachments = (raw.attachments as Array<Record<string, unknown>>).map((a) => ({
			fileName: typeof a?.fileName === 'string' ? a.fileName : undefined,
			mediaType: typeof a?.mediaType === 'string' ? a.mediaType : undefined,
			data: typeof a?.data === 'string' ? a.data : undefined,
		}));
	}
	if (Array.isArray(raw?.fileTags)) {
		payload.fileTags = (raw.fileTags as Array<Record<string, unknown>>)
			.filter((t) => t && typeof t === 'object')
			.map((t) => ({
				displayPath: typeof t.displayPath === 'string' ? t.displayPath : undefined,
				absolutePath: typeof t.absolutePath === 'string' ? t.absolutePath : undefined,
			}));
	}
	if (typeof raw?.permissionMode === 'string' && isValidPermissionMode(raw.permissionMode)) {
		payload.permissionMode = raw.permissionMode;
	}
	if (typeof raw?.reasoningEffort === 'string') {
		payload.reasoningEffort = raw.reasoningEffort;
	}
	return payload;
}
