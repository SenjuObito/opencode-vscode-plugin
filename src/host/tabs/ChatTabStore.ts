/**
 * ChatTabStore — 聊天标签列表的持久化。
 *
 * 之前持久化的是「原生 panel → sessionId」，因为一个 panel 就是一份会话。
 * 单实例之后，会话归属于**聊天标签**而不是窗口，窗口只是标签的展示容器，
 * 因此这里保存的是全局标签列表 + 当前激活标签。
 *
 * 消息本体不落盘：它们属于 opencode 服务端，重开时由 SessionResync 重新拉取。
 */
import type * as vscode from 'vscode';

export interface ChatTabRecord {
	id: string;
	sessionId: string | null;
	title: string;
	isCustomTitle?: boolean;
	isShared?: boolean;
}

export interface ChatTabsSnapshot {
	tabs: ChatTabRecord[];
	activeTabId: string | null;
}

const CHAT_TABS_KEY = 'opencode.chatTabs';

export class ChatTabStore {
	constructor(private readonly memento: vscode.Memento) {}

	load(): ChatTabsSnapshot | null {
		const raw = this.memento.get<unknown>(CHAT_TABS_KEY);
		if (!raw || typeof raw !== 'object') {
			return null;
		}
		const obj = raw as Record<string, unknown>;
		if (!Array.isArray(obj.tabs)) {
			return null;
		}
		const tabs: ChatTabRecord[] = [];
		for (const entry of obj.tabs) {
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
		const activeTabId = typeof obj.activeTabId === 'string' ? obj.activeTabId : null;
		return {
			tabs,
			activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null),
		};
	}

	save(snapshot: ChatTabsSnapshot): void {
		void this.memento.update(CHAT_TABS_KEY, snapshot);
	}

	clear(): void {
		void this.memento.update(CHAT_TABS_KEY, undefined);
	}
}
