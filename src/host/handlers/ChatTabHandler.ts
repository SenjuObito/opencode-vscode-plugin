/**
 * ChatTabHandler — 聊天标签的跨视图同步与持久化。
 *
 * 单实例之后，标签列表是**全局状态**，但每个 webview 各有一份 React 副本。
 * 由发起变更的视图把结构快照发上来，宿主落盘后广播给所有视图（含发起者，
 * 发起者按 `source` 忽略自己的回声），保证多个窗口的标签栏完全一致。
 *
 * 类型：
 *  - `sync_tabs`  结构快照上行（id / sessionId / title / 激活项）
 *  - `get_tabs`   视图挂载时索取一次权威快照
 *  - `request_session_snapshot` 远端切换标签后补一次会话内容，避免拿到旧副本
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { ChatTabRecord, ChatTabStore, ChatTabsSnapshot } from '../tabs/ChatTabStore';

const SUPPORTED_TYPES = ['sync_tabs', 'get_tabs', 'request_session_snapshot'];

function normalizeTabs(raw: unknown): ChatTabRecord[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	const tabs: ChatTabRecord[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const tab = entry as Record<string, unknown>;
		const id = typeof tab.id === 'string' ? tab.id : '';
		if (!id) {
			continue;
		}
		tabs.push({
			id,
			sessionId: typeof tab.sessionId === 'string' && tab.sessionId.trim() !== ''
				? tab.sessionId
				: null,
			title: typeof tab.title === 'string' ? tab.title : '',
			isCustomTitle: tab.isCustomTitle === true,
			isShared: tab.isShared === true,
		});
	}
	return tabs;
}

function settle(tabs: ChatTabRecord[], activeTabId: string | null): ChatTabsSnapshot {
	return {
		tabs,
		activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null),
	};
}

export class ChatTabHandler extends BaseMessageHandler {
	constructor(
		context: HandlerContext,
		private readonly store: ChatTabStore,
	) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'sync_tabs':
				this.handleSync(content);
				return true;
			case 'get_tabs':
				this.handleGet();
				return true;
			case 'request_session_snapshot':
				this.context.getSession()?.hydrateSessionToWebview({ origin: true });
				return true;
			default:
				return false;
		}
	}

	private handleSync(content: string): void {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(content) as Record<string, unknown>;
		} catch {
			return;
		}
		const tabs = normalizeTabs(parsed.tabs);
		if (!tabs) {
			return;
		}
		const activeTabId = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null;
		const snapshot = settle(tabs, activeTabId);
		this.store.save(snapshot);
		const source = typeof parsed.source === 'string' ? parsed.source : null;
		// 广播给所有视图；发起者按 source 丢弃回声，避免自激循环。
		this.context.callJavaScript('apply_tabs', JSON.stringify({ ...snapshot, restored: true, source }));
	}

	private handleGet(): void {
		const stored = this.store.load();
		const snapshot = stored ?? { tabs: [], activeTabId: null };
		this.context.callJavaScriptToOrigin(
			'apply_tabs',
			JSON.stringify({ ...snapshot, restored: stored !== null, source: null }),
		);
	}
}
