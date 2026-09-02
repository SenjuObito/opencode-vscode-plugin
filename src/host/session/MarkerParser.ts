/**
 * MarkerParser — port of cc-gui `provider/claude/ClaudeStreamAdapter.java`.
 * Adapts tagged daemon output lines into MessageCallback events.
 * The daemon normalizes opencode SDK events into these markers (see
 * ai-bridge utils/marker-protocol.js).
 */
import { MessageCallback } from './MessageHandler';
import { logDiagnostic } from '../util/DiagnosticLogger';

/** 单轮流式解析上下文（随一次 send 的整个生命周期）。 */
export interface MarkerStreamContext {
	assistantContent: string;
	hadSendError: boolean;
	lastNodeError: string | null;
	wasAborted: boolean;
}

/** 解析一条 daemon 输出行，分发到 MessageCallback。 */
export function processOutputLine(
	line: string,
	callback: MessageCallback,
	context: MarkerStreamContext,
): void {
	if (
		line.startsWith('[STDIN_ERROR]') ||
		line.startsWith('[STDIN_PARSE_ERROR]') ||
		line.startsWith('[GET_SESSION_ERROR]') ||
		line.startsWith('[PERSIST_ERROR]')
	) {
		context.lastNodeError = line;
	}

	if (line.startsWith('[MESSAGE]')) {
		const jsonStr = line.substring('[MESSAGE]'.length).trim();
		try {
			const msg = JSON.parse(jsonStr);
			const type = msg && typeof msg.type === 'string' ? msg.type : 'unknown';
			if (type === 'assistant') {
				const msgObj = msg.message as Record<string, unknown> | undefined;
				const contentArr = Array.isArray(msgObj?.content) ? msgObj.content : [];
				for (const block of contentArr) {
					if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
						const b = block as Record<string, unknown>;
						const inp = (b.input ?? {}) as Record<string, unknown>;
						console.log(`[MarkerParser] [MESSAGE] tool_use: name=${b.name} id=${b.id} inputKeys=${Object.keys(inp)} inputPreview=${JSON.stringify(inp).substring(0, 200)}`);
					}
				}
			}
			callback.onMessage(type, jsonStr);
		} catch {
			// 忽略解析失败
		}
		return;
	}

	if (line.startsWith('[SEND_ERROR]')) {
		// 用户主动中断时抑制 SEND_ERROR，避免 UI 弹出错误提示。
		if (context.wasAborted) {
			return;
		}
		let jsonStr = line.substring('[SEND_ERROR]'.length).trim();
		let errorMessage = jsonStr;
		try {
			const obj = JSON.parse(jsonStr);
			if (typeof obj.error === 'string') {
				errorMessage = obj.error;
			}
		} catch {
			// 保留原始字符串
		}
		context.hadSendError = true;
		callback.onError(errorMessage);
		return;
	}

	if (line.startsWith('[CONTENT]')) {
		const content = line.substring('[CONTENT]'.length).trim();
		context.assistantContent += content;
		callback.onMessage('content', content);
		return;
	}

	if (line.startsWith('[CONTENT_DELTA]')) {
		const delta = decodeJsonStringPayload(line.substring('[CONTENT_DELTA]'.length));
		context.assistantContent += delta;
		callback.onMessage('content_delta', delta);
		return;
	}

	if (line.startsWith('[THINKING]')) {
		const thinkingContent = line.substring('[THINKING]'.length).trim();
		callback.onMessage('thinking', thinkingContent);
		return;
	}

	if (line.startsWith('[THINKING_DELTA]')) {
		const thinkingDelta = decodeJsonStringPayload(line.substring('[THINKING_DELTA]'.length));
		callback.onMessage('thinking_delta', thinkingDelta);
		return;
	}

	if (line.startsWith('[STREAM_START]')) {
		callback.onMessage('stream_start', '');
		return;
	}

	if (line.startsWith('[STREAM_END]')) {
		callback.onMessage('stream_end', '');
		return;
	}

	if (line.startsWith('[SESSION_ID]')) {
		callback.onMessage('session_id', line.substring('[SESSION_ID]'.length).trim());
		return;
	}

	if (line.startsWith('[TOOL_RESULT]')) {
		callback.onMessage('tool_result', line.substring('[TOOL_RESULT]'.length).trim());
		return;
	}

	if (line.startsWith('[USAGE]')) {
		callback.onMessage('usage', line.substring('[USAGE]'.length).trim());
		return;
	}

	if (line.startsWith('[REVERT_STATE]')) {
		const payload = line.substring('[REVERT_STATE]'.length).trim();
		try {
			const parsed = JSON.parse(payload);
			callback.onMessage('revert_state', JSON.stringify(parsed));
		} catch {
			callback.onMessage('revert_state', payload);
		}
		return;
	}

	if (line.startsWith('[MESSAGE_START]')) {
		callback.onMessage('message_start', '');
		return;
	}

	if (line.startsWith('[BLOCK_RESET]')) {
		callback.onMessage('block_reset', '');
		return;
	}

	if (line.startsWith('[MESSAGE_END]')) {
		callback.onMessage('message_end', '');
		return;
	}

	if (line.startsWith('[PERMISSION_REQUEST]')) {
		const payload = line.substring('[PERMISSION_REQUEST]'.length).trim();
		logDiagnostic(`[MarkerParser] PERMISSION_REQUEST payload=${payload.substring(0, 200)}`);
		callback.onMessage('permission_request', payload);
	        return;
	}

	if (line.startsWith('[QUESTION_REQUEST]')) {
		const payload = line.substring('[QUESTION_REQUEST]'.length).trim();
		logDiagnostic(`[MarkerParser] QUESTION_REQUEST payload=${payload.substring(0, 200)}`);
		callback.onMessage('question_request', payload);
		return;
	}

	if (line.startsWith('[QUESTION_CLOSED]')) {
		const payload = line.substring('[QUESTION_CLOSED]'.length).trim();
		logDiagnostic(`[MarkerParser] QUESTION_CLOSED payload=${payload}`);
		callback.onMessage('question_closed', payload);
		return;
	}

	if (line.startsWith('[PERMISSION_CLOSED]')) {
		const payload = line.substring('[PERMISSION_CLOSED]'.length).trim();
		logDiagnostic(`[MarkerParser] PERMISSION_CLOSED payload=${payload}`);
		callback.onMessage('permission_closed', payload);
		return;
	}

	if (line.startsWith('[TODO_UPDATED]')) {
		// ai-bridge 调用的是
		//   emitJsonStringMarker('[TODO_UPDATED]', JSON.stringify({ sessionID, todos }))
		// 而 emitJsonStringMarker 定义为 `tag + JSON.stringify(text)` —— 于是这里
		// 拿到的是**双重编码**的字符串（形如 "{\"sessionID\":\"...\"}"）。
		//
		// 不解这层的话，webview 的 window.onTodoUpdated 只 JSON.parse 一次，
		// 得到的仍是字符串，解构出的 sessionID / todos 全是 undefined，
		// 于是命中 `sessionID !== currentSessionId` 被 SKIPPED —— todo 列表
		// 永远收不到更新（只在历史加载时由消息块兜底显示）。
		//
		// decodeJsonStringPayload 是幂等的：单层编码时解析结果是对象，会原样返回。
		const payload = decodeJsonStringPayload(line.substring('[TODO_UPDATED]'.length).trim());
		logDiagnostic(`[MarkerParser] TODO_UPDATED payload=${payload.substring(0, 300)}`);
		callback.onMessage('todo_updated', payload);
		return;
	}
}

/** 解码被 JSON 字符串包裹的载荷（如 [CONTENT_DELTA] 后跟 JSON 字符串）。 */
function decodeJsonStringPayload(rawPayload: string): string {
	const jsonStr = rawPayload.startsWith(' ') ? rawPayload.substring(1) : rawPayload;
	try {
		const parsed = JSON.parse(jsonStr);
		return typeof parsed === 'string' ? parsed : jsonStr;
	} catch {
		return jsonStr;
	}
}
