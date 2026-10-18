import { SessionLineSink } from '../provider/OpenCodeDaemonBridge';
import { SessionState } from './SessionState';
import { CallbackHandler } from './CallbackHandler';
import { MessageHandler } from './MessageHandler';
import { MarkerStreamContext, processOutputLine } from './MarkerParser';
import { logDiagnostic } from '../util/DiagnosticLogger';

/**
 * SessionStreamRouter — 宿主侧每会话常驻数据面路由器。
 *
 * 架构对齐：opencode-idea-gui 的 `session/SessionStreamRouter.java`。
 *
 * 一个会话实例（OpenCodeSession）独占一个 SessionStreamRouter。
 * daemon 播报数据行时根据信封上的 `session` 字段直接投递给本 router，
 * 由常驻的 MarkerStreamContext 和 MessageHandler 消费，保障多会话并发流式隔离。
 */
export class SessionStreamRouter implements SessionLineSink {
	private readonly messageHandler: MessageHandler;
	private readonly streamContext: MarkerStreamContext = {
		assistantContent: '',
		hadSendError: false,
		lastNodeError: null,
		wasAborted: false,
	};

	constructor(state: SessionState, callbackHandler: CallbackHandler) {
		this.messageHandler = new MessageHandler(state, callbackHandler);
	}

	getMessageHandler(): MessageHandler {
		return this.messageHandler;
	}

	getStreamContext(): MarkerStreamContext {
		return this.streamContext;
	}

	onLine(line: string): void {
		try {
			processOutputLine(line, this.messageHandler, this.streamContext);
		} catch (e) {
			logDiagnostic(`[SessionStreamRouter] Failed to process line: ${(e as Error).message}`);
		}
	}

	onStderr(text: string): void {
		if (text && text.trim() !== '') {
			this.messageHandler.onMessage('node_log', text);
		}
	}
}
