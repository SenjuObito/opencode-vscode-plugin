/**
 * WebviewBroadcaster — 全局 Webview 通道广播器。
 *
 * 维护所有存活的 WebviewChannel（侧边栏 BroadcastChannel 与各编辑器 Tab 的 SingleWebviewChannel）。
 * 当全局设置（主题、语言、UI 偏好、字体、快捷键等）发生变更时，向所有通道同步广播，
 * 确保「一处修改，所有标签页实时联动生效」，同时保持各 Tab 会话消息通道相互独立。
 */
import { WebviewChannel } from './HandlerContext';

export class WebviewBroadcaster {
	private static readonly channels = new Set<WebviewChannel>();

	/** 注册一个活跃通道，返回注销函数。 */
	static register(channel: WebviewChannel): () => void {
		this.channels.add(channel);
		return () => {
			this.channels.delete(channel);
		};
	}

	static unregister(channel: WebviewChannel): void {
		this.channels.delete(channel);
	}

	/** 向所有未销毁的通道广播 JS 调用。 */
	static broadcastJavaScript(functionName: string, ...args: string[]): void {
		for (const channel of [...this.channels]) {
			if (!channel.isDisposed()) {
				try {
					channel.callJavaScript(functionName, ...args);
				} catch {
					this.channels.delete(channel);
				}
			} else {
				this.channels.delete(channel);
			}
		}
	}

	/** 向所有未销毁的通道广播原始消息。 */
	static broadcastRaw(message: unknown): void {
		for (const channel of [...this.channels]) {
			if (!channel.isDisposed()) {
				try {
					channel.postRaw(message);
				} catch {
					this.channels.delete(channel);
				}
			} else {
				this.channels.delete(channel);
			}
		}
	}

	static getChannelCount(): number {
		return this.channels.size;
	}
}
