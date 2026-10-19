/**
 * ViewRegistry — 一个聊天实例下挂载的所有视图通道。
 *
 * 插件从「每个面板一个实例」收敛为「一个实例、N 个视图」：
 * 侧边栏左/右、每个编辑器 panel 都是同一个 `ChatInstance` 的挂载点，
 * 共享同一份会话、标签与模型状态。
 *
 * 它同时实现 `WebviewChannel`，因此可以原样塞进 `HandlerContext`：
 *  - `callJavaScript` 默认广播给所有视图（会话消息、流式增量、状态回放）；
 *  - `callJavaScriptTo` 只发给某一个视图（就绪握手、编辑器上下文这类
 *    天然属于单个视图的推送）。
 *
 * 视图关闭只解绑，不影响实例本身；实例随扩展生命周期存活。
 */
import type { WebviewChannel } from './HandlerContext';

export interface ViewAttachment {
	/** 稳定标识：`view:left` / `view:right` / `panel:<tabId>`。 */
	readonly id: string;
	readonly kind: 'sidebar' | 'panel';
	readonly channel: WebviewChannel;
	/** 视图当前是否对用户可见（用于选择「前台视图」）。 */
	isVisible(): boolean;
}

export class ViewRegistry implements WebviewChannel {
	private readonly views = new Map<string, ViewAttachment>();
	private readonly ready = new Set<string>();
	private readonly readyListeners = new Set<(viewId: string) => void>();

	/** 挂载一个视图；返回解绑函数（幂等）。 */
	attach(view: ViewAttachment): () => void {
		this.views.set(view.id, view);
		return () => this.detach(view.id);
	}

	/** 订阅「某个视图首次就绪」；返回取消订阅函数。 */
	onReady(listener: (viewId: string) => void): () => void {
		this.readyListeners.add(listener);
		return () => this.readyListeners.delete(listener);
	}

	detach(viewId: string): void {
		this.views.delete(viewId);
		this.ready.delete(viewId);
	}

	get(viewId: string): ViewAttachment | undefined {
		return this.views.get(viewId);
	}

	ids(): string[] {
		return [...this.views.keys()];
	}

	size(): number {
		return this.views.size;
	}

	/** 第一个可见视图；都不可见时退回第一个挂载视图。 */
	firstVisible(): ViewAttachment | undefined {
		for (const view of this.views.values()) {
			if (view.isVisible()) {
				return view;
			}
		}
		return this.views.values().next().value;
	}

	markReady(viewId: string): void {
		if (!this.views.has(viewId) || this.ready.has(viewId)) {
			return;
		}
		this.ready.add(viewId);
		for (const listener of [...this.readyListeners]) {
			try {
				listener(viewId);
			} catch {
				// 单个订阅者出错不应阻断其余订阅者。
			}
		}
	}

	readyIds(): string[] {
		return [...this.ready];
	}

	unmarkReady(viewId: string): void {
		this.ready.delete(viewId);
	}

	isReady(viewId: string): boolean {
		return this.ready.has(viewId);
	}

	hasReadyView(): boolean {
		return this.ready.size > 0;
	}

	/** 广播：所有挂载视图各收一份。 */
	callJavaScript(functionName: string, ...args: string[]): void {
		for (const view of [...this.views.values()]) {
			if (view.channel.isDisposed()) {
				this.detach(view.id);
				continue;
			}
			try {
				view.channel.callJavaScript(functionName, ...args);
			} catch {
				// 视图在推送途中销毁：解绑即可，不能让它拖垮其余视图。
				this.detach(view.id);
			}
		}
	}

	/** 定向投递：只发给指定视图；视图不存在返回 false。 */
	callJavaScriptTo(viewId: string, functionName: string, ...args: string[]): boolean {
		const view = this.views.get(viewId);
		if (!view || view.channel.isDisposed()) {
			this.detach(viewId);
			return false;
		}
		try {
			view.channel.callJavaScript(functionName, ...args);
			return true;
		} catch {
			this.detach(viewId);
			return false;
		}
	}

	postRaw(message: unknown): void {
		for (const view of [...this.views.values()]) {
			if (view.channel.isDisposed()) {
				this.detach(view.id);
				continue;
			}
			try {
				view.channel.postRaw(message);
			} catch {
				this.detach(view.id);
			}
		}
	}

	/** 没有挂载视图时视为已释放。 */
	isDisposed(): boolean {
		return this.views.size === 0;
	}

	getViewCount(): number {
		return this.views.size;
	}
}
