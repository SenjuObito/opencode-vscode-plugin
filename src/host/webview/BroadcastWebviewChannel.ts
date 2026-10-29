/**
 * BroadcastWebviewChannel — 单实例多视图装配下的「全局通道」。
 *
 * 多视图后不存在「某个 webview 的 channel」这一概念：会话与 handler 是全局的，
 * 输出要送达所有存活视图（侧边栏左右 + 编辑器 panel）。本通道只是把 callJavaScript /
 * postRaw 转发给 `WebviewBroadcaster`，自身不注册进广播表（否则会自我递归）。
 *
 * 会话数据通过命名 `TabEvent` 由 `TabEventRouter` 广播到所有视图；本通道只承载
 * 视图级/全局消息。
 */
import type { WebviewChannel } from '../router/HandlerContext';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';

export class BroadcastWebviewChannel implements WebviewChannel {
	callJavaScript(functionName: string, ...args: string[]): void {
		WebviewBroadcaster.broadcastJavaScript(functionName, ...args);
	}

	postRaw(message: unknown): void {
		WebviewBroadcaster.broadcastRaw(message);
	}

	/** 永远存活：存活视图数由广播表决定。 */
	isDisposed(): boolean {
		return false;
	}

	getViewCount(): number {
		return WebviewBroadcaster.getChannelCount();
	}
}
