/**
 * SessionHistoryStore — opencode 会话历史索引的共享读写逻辑。
 *
 * HistoryHandler（历史列表）与 WindowEventHandler（fork 后同步新会话）
 * 都需要操作同一份本地缓存（SettingsStore 全局键）。此前 upsert 与
 * setHistoryData 推送逻辑私有在 HistoryHandler 内，导致 fork 出的新会话
 * 无法进入会话列表。这里抽出最小共享面：
 *
 *   - HISTORY_KEY / FAVORITES_KEY / HistorySessionSummary：存储契约
 *   - upsertSessionSummary()：插入或合并会话摘要（缺省字段不覆盖已有值）
 *   - pushHistoryData()：向 webview 推送 `setHistoryData`
 */
import type { SettingsStore } from '../settings/SettingsService';

export interface HistorySessionSummary {
	sessionId: string;
	title: string;
	messageCount: number;
	lastTimestamp?: string;
	isFavorited?: boolean;
	favoritedAt?: number;
	provider?: string;
	model?: string;
	entrypoint?: string;
}

export const HISTORY_KEY = 'opencode.history.sessions';
export const FAVORITES_KEY = 'opencode.history.favorites';

const MAX_SESSIONS = 200;

export function getSessions(store: SettingsStore): HistorySessionSummary[] {
	const raw = store.getGlobal(HISTORY_KEY);
	return Array.isArray(raw) ? (raw as HistorySessionSummary[]) : [];
}

export function setSessions(store: SettingsStore, sessions: HistorySessionSummary[]): void {
	store.setGlobal(HISTORY_KEY, sessions);
}

export function getFavorites(store: SettingsStore): Record<string, { favoritedAt: number }> {
	const raw = store.getGlobal(FAVORITES_KEY);
	return raw && typeof raw === 'object' ? (raw as Record<string, { favoritedAt: number }>) : {};
}

export function setFavorites(store: SettingsStore, favorites: Record<string, { favoritedAt: number }>): void {
	store.setGlobal(FAVORITES_KEY, favorites);
}

/** 插入或合并一条会话摘要；未提供的字段不覆盖缓存中的已有值。 */
export function upsertSessionSummary(
	store: SettingsStore,
	sessionId: string,
	title: string,
	opts?: { messageCount?: number; model?: string },
): void {
	if (!sessionId) {
		return;
	}
	const sessions = getSessions(store);
	const existing = sessions.find((s) => s.sessionId === sessionId);
	if (existing) {
		existing.lastTimestamp = new Date().toISOString();
		if (title && existing.title !== title) {
			existing.title = title;
		}
		if (typeof opts?.messageCount === 'number') {
			existing.messageCount = opts.messageCount;
		}
		if (opts?.model && existing.model !== opts.model) {
			existing.model = opts.model;
		}
	} else {
		sessions.unshift({
			sessionId,
			title: title || 'New chat',
			messageCount: opts?.messageCount ?? 0,
			lastTimestamp: new Date().toISOString(),
			provider: 'opencode',
			entrypoint: 'sdk',
			...(opts?.model ? { model: opts.model } : {}),
		});
	}
	sessions.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));
	store.setGlobal(HISTORY_KEY, sessions.slice(0, MAX_SESSIONS));
}

/** 向 webview 推送完整历史数据（含收藏标记）。 */
export function pushHistoryData(
	channel: { callJavaScript(functionName: string, ...args: string[]): void },
	store: SettingsStore,
): void {
	const favorites = getFavorites(store);
	const sessions = getSessions(store).map((s) => ({
		...s,
		isFavorited: Boolean(favorites[s.sessionId]),
		favoritedAt: favorites[s.sessionId]?.favoritedAt,
	}));
	channel.callJavaScript(
		'setHistoryData',
		JSON.stringify({ success: true, sessions, total: sessions.length, favorites }),
	);
}
