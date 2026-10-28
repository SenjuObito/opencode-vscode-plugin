/**
 * TabScopedSink — 把某个 tab 的会话输出投影到「当前活跃 tab」的视图上。
 *
 * 多 tab 装配后所有 tab 共用一套视图通道：`updateMessages` / `onContentDelta`
 * 这类回调都是**单会话语义**的（webview 只有一份消息列表），因此后台 tab 的输出
 * 必须被丢弃——宿主状态才是权威，切回该 tab 时由 `ChatWindow.replayTab` 回放快照。
 *
 * 例外：`addErrorMessage` 是瞬时 toast，不算状态，后台 tab 的失败也必须让用户看到，
 * 所以无条件放行。
 */
import type { JsTarget } from '../session/SessionCallbackAdapter';

const ALWAYS_PASS = new Set<string>(['addErrorMessage']);

export class TabScopedSink implements JsTarget {
	private blockedCount = 0;

	constructor(
		readonly tabId: string,
		private readonly isActive: () => boolean,
		private readonly target: JsTarget,
	) {}

	callJavaScript(functionName: string, ...args: string[]): void {
		if (!ALWAYS_PASS.has(functionName) && !this.isActive()) {
			this.blockedCount += 1;
			return;
		}
		this.target.callJavaScript(functionName, ...args);
	}

	/** 被投影拦下的调用数（诊断用：长期只增说明该 tab 一直被压在后台）。 */
	getBlockedCount(): number {
		return this.blockedCount;
	}
}
