/**
 * SessionResync — 视图重新可见 / 重载后，把会话从服务端补齐。
 *
 * 对应 idea `OpencodeBuddyChatWindow.resyncSessionFromServerIfNeeded`
 * （`OpencodeBuddyChatWindow.java:1825-1930`）。
 *
 * 触发面：
 *  - 原生编辑 panel 从不可见变为可见（`panel.onDidChangeViewState`）；
 *  - webview 重载后 `frontend_ready`（panel 语义）。
 *
 * 判据收紧为「本视图还没有任何消息、且会话空闲」：`loadFromServer()` 是
 * 破坏性的（先清空再灌入），视图里已有内容时重载会把它们抹掉。
 *
 * 失败与「成功但为空」都要重试 —— `opencode.listMessages` 在 daemon/serve 未就绪
 * 时会失败，如果当成「成功但为空」收下，就会留下「sessionId 已绑定 + 消息为空」的
 * 幽灵态：界面看着是新会话，用户一发送消息就被追加到旧会话，旧对话整份冒出来。
 * 重试用尽后解除绑定，该会话仍在服务端历史里，随时可以重新打开。
 */
import type { OpenCodeSession } from './OpenCodeSession';
import { logDiagnostic } from '../util/DiagnosticLogger';

export type ResyncOutcome = 'skipped' | 'loaded' | 'unbound';

export interface ResyncOptions {
	/** webview 是否已就绪：未就绪时 callJavaScript 会丢。 */
	frontendReady: boolean;
	maxAttempts?: number;
	retryDelayMs?: number;
	/** 便于测试注入的延时器。 */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 600;

/** 同一会话同一时刻只允许一次重同步，避免可见性抖动打出多份 listMessages。 */
const inFlight = new WeakSet<OpenCodeSession>();

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @returns `skipped` 未满足前置条件；`loaded` 已补齐消息；`unbound` 重试用尽，
 *   会话绑定已解除（调用方可以提示用户「已开始新会话」）。
 */
export async function resyncSessionFromServerIfNeeded(
	session: OpenCodeSession,
	options: ResyncOptions,
): Promise<ResyncOutcome> {
	if (!options.frontendReady) {
		return 'skipped';
	}
	if (!session.state.getSessionId()) {
		return 'skipped';
	}
	// 视图里已经有消息 / 正在流式 / 正在加载：绝不重载。
	if (session.state.isBusy() || session.state.isLoading() || session.state.getMessages().length > 0) {
		return 'skipped';
	}
	if (inFlight.has(session)) {
		return 'skipped';
	}
	inFlight.add(session);

	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? defaultSleep;

	try {
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			let failure: unknown = null;
			try {
				await session.loadFromServer();
			} catch (error) {
				failure = error;
			}
			const messageCount = session.state.getMessages().length;
			if (!failure && messageCount > 0) {
				session.hydrateSessionToWebview();
				session.notifyHistoryLoadComplete();
				return 'loaded';
			}
			logDiagnostic(
				`[SessionResync] messages not available (attempt ${attempt}/${maxAttempts}): `
				+ (failure ? (failure instanceof Error ? failure.message : String(failure)) : 'empty result'),
			);
			if (attempt < maxAttempts) {
				await sleep(retryDelayMs);
			}
		}

		// 重试用尽：解除绑定，绝不留下「绑着 sessionId 却没有消息」的会话。
		logDiagnostic('[SessionResync] giving up — unbinding session so the next send starts a new conversation');
		session.resetSession();
		session.notifyHistoryLoadComplete();
		session.notifyMessageLoadFailure();
		return 'unbound';
	} finally {
		inFlight.delete(session);
	}
}
