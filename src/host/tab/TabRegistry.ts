import { TabId } from './TabId';
import { SessionId } from './SessionId';
import { TabRecord } from './TabRecord';
import { TabState } from './TabState';
import { TabSnapshot } from './TabSnapshot';
import { TabEventSink } from './TabEvent';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SessionCallbackAdapter } from '../session/SessionCallbackAdapter';
import type { StreamMessageCoalescer } from '../session/StreamMessageCoalescer';

/**
 * The single owner of tab -> session bindings for the chat window.
 * Enforces key invariants:
 * - A tab exists independently of a session.
 * - One tab <= 1 canonical session.
 * - One canonical session <= 1 tab.
 * - Host is authoritative over activeTabId and order.
 */
export class TabRegistry {
	private readonly tabs = new Map<string, TabRecord>();
	private readonly sessionIndex = new Map<string, TabId>();
	private tabOrder: TabId[] = [];
	private activeTabId: TabId | null = null;
	private eventSink: TabEventSink = () => {};

	setEventSink(sink: TabEventSink): void {
		this.eventSink = sink || (() => {});
	}

	create(tabId: TabId, cwd: string = ''): TabRecord {
		const existing = this.tabs.get(tabId.value);
		if (existing) {
			if (existing.isClosed()) {
				throw new Error(`tab is closed: ${tabId.value}`);
			}
			return existing;
		}

		const record = new TabRecord(tabId, cwd, this.eventSink);
		this.tabs.set(tabId.value, record);
		this.tabOrder.push(tabId);

		if (!this.activeTabId) {
			this.activeTabId = tabId;
		}

		return record;
	}

	get(tabId: TabId | null | undefined): TabRecord | null {
		if (!tabId) {
			return null;
		}
		return this.tabs.get(tabId.value) || null;
	}

	require(tabId: TabId): TabRecord {
		const record = this.get(tabId);
		if (!record) {
			throw new Error(`unknown tabId: ${tabId.value}`);
		}
		if (record.isClosed()) {
			throw new Error(`tab is closed: ${tabId.value}`);
		}
		return record;
	}

	findBySession(sessionId: SessionId | string | null | undefined): TabRecord | null {
		if (!sessionId) {
			return null;
		}
		const raw = typeof sessionId === 'string' ? sessionId : sessionId.value;
		const tabId = this.sessionIndex.get(raw);
		return tabId ? this.get(tabId) : null;
	}

	markCreating(tabId: TabId): void {
		const record = this.require(tabId);
		if (record.getSessionId()) {
			throw new Error(`tab already bound: ${tabId.value}`);
		}
		record.setState(TabState.CREATING);
	}

	/**
	 * Atomically binds canonical session to tab.
	 * Enforces INV-3.
	 */
	bind(
		tabId: TabId,
		canonicalSessionId: string | SessionId,
		session: OpenCodeSession | null,
		adapter: SessionCallbackAdapter | null,
		coalescer: StreamMessageCoalescer | null,
	): void {
		const record = this.require(tabId);
		const sessionId = typeof canonicalSessionId === 'string'
			? SessionId.of(canonicalSessionId)
			: canonicalSessionId;

		const current = record.getSessionId();
		if (current && !current.equals(sessionId)) {
			throw new Error(`tab ${tabId.value} already bound to ${current.value}`);
		}

		const owner = this.sessionIndex.get(sessionId.value);
		if (owner && !owner.equals(tabId)) {
			throw new Error(`session ${sessionId.value} already owned by ${owner.value}`);
		}

		record.setSessionResources(sessionId, session, adapter, coalescer);
		record.setState(TabState.BOUND);
		record.bumpEpoch();
		this.sessionIndex.set(sessionId.value, tabId);
	}

	/**
	 * 解除 tab 与会话的绑定，**保留 tab**。
	 *
	 * 用于「在同一个 tab 里开新对话」：tab 的界面与位置不变，但它不再拥有任何
	 * 服务端会话，`sessionIndex` 同步释放（否则旧 sessionId 会继续反查到本 tab）。
	 */
	release(tabId: TabId): void {
		const record = this.tabs.get(tabId.value);
		if (!record) {
			return;
		}
		const sessionId = record.getSessionId();
		if (sessionId) {
			this.sessionIndex.delete(sessionId.value);
		}
		record.attachPendingSession(null, null, null);
		if (!record.isClosed()) {
			record.setState(TabState.NEW);
		}
	}

	markLoadingHistory(tabId: TabId): void {		const record = this.require(tabId);
		if (record.isStreaming()) {
			throw new Error(`cannot replace a streaming tab: ${tabId.value}`);
		}
		record.setState(TabState.LOADING_HISTORY);
	}

	markBound(tabId: TabId): void {
		const record = this.require(tabId);
		if (record.isBound()) {
			record.setState(TabState.BOUND);
		}
	}

	markStreaming(tabId: TabId, streaming: boolean): void {
		const record = this.get(tabId);
		if (!record || record.isClosed()) {
			return;
		}
		if (streaming) {
			record.setState(TabState.STREAMING);
		} else if (record.isBound()) {
			record.setState(TabState.BOUND);
		}
	}

	activate(tabId: TabId): void {
		this.require(tabId);
		this.activeTabId = tabId;
	}

	getActiveTabId(): TabId | null {
		return this.activeTabId;
	}

	getOrder(): TabId[] {
		return [...this.tabOrder];
	}

	reorder(newOrder: TabId[]): void {
		const validTabs = new Set(this.tabs.keys());
		const filtered = newOrder.filter((id) => validTabs.has(id.value));
		// Append any remaining tabs not present in newOrder
		const seen = new Set(filtered.map((id) => id.value));
		for (const id of this.tabOrder) {
			if (!seen.has(id.value) && validTabs.has(id.value)) {
				filtered.push(id);
			}
		}
		this.tabOrder = filtered;
	}

	all(): TabRecord[] {
		return Array.from(this.tabs.values());
	}

	liveTabs(): TabRecord[] {
		return Array.from(this.tabs.values()).filter((r) => !r.isClosed());
	}

	snapshots(): TabSnapshot[] {
		const result: TabSnapshot[] = [];
		// Emit according to tabOrder
		const liveMap = new Map<string, TabRecord>();
		for (const r of this.liveTabs()) {
			liveMap.set(r.getTabId().value, r);
		}

		for (const id of this.tabOrder) {
			const record = liveMap.get(id.value);
			if (record) {
				const isCurrentActive = this.activeTabId ? id.equals(this.activeTabId) : false;
				result.push(
					new TabSnapshot(
						record.getTabId().value,
						record.getSessionIdString(),
						record.getTitle(),
						isCurrentActive,
						record.isStreaming(),
						record.getState() === TabState.LOADING_HISTORY,
						record.getEpoch(),
						record.getSettings().getDraft(),
					),
				);
			}
		}
		return result;
	}

	/**
	 * Close and remove tab, releasing both indexes. Idempotent.
	 */
	close(tabId: TabId): TabRecord | null {
		const record = this.tabs.get(tabId.value);
		if (!record) {
			return null;
		}
		if (record.isClosed()) {
			return record;
		}

		const sessionId = record.getSessionId();
		if (sessionId) {
			this.sessionIndex.delete(sessionId.value);
		}

		const closedIndex = this.tabOrder.findIndex((id) => id.equals(tabId));

		record.close();
		this.tabs.delete(tabId.value);
		this.tabOrder = this.tabOrder.filter((id) => !id.equals(tabId));

		if (this.activeTabId && this.activeTabId.equals(tabId)) {
			// 与 idea 的 closeTab/closeTabsBatch 同一规则：优先左邻，没有则右邻，
			// 全空则为 null。宿主镜像的 active 必须与视图即将下发的 tab.activate
			// 一致，否则多视图会在关闭瞬间各选一个邻居。
			this.activeTabId = this.tabOrder.length === 0
				? null
				: this.tabOrder[Math.max(0, Math.min(closedIndex - 1, this.tabOrder.length - 1))];
		}

		return record;
	}

	size(): number {
		return this.tabs.size;
	}

	clear(): void {
		for (const record of this.tabs.values()) {
			record.close();
		}
		this.tabs.clear();
		this.sessionIndex.clear();
		this.tabOrder = [];
		this.activeTabId = null;
	}
}
