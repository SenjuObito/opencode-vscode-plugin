import { TabRegistry } from './TabRegistry';
import { TabRecord } from './TabRecord';
import { TabId } from './TabId';
import { SessionId } from './SessionId';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SessionCallbackAdapter } from '../session/SessionCallbackAdapter';
import type { StreamMessageCoalescer } from '../session/StreamMessageCoalescer';

/**
 * 会话资源的提供方。
 *
 * 会话自持 adapter / coalescer（`OpenCodeSession` 构造时就建好两者，输出走该会话
 * 自己的 viewSink），工厂只需要「造一个会话」+「问它要这两个资源」。早期版本按
 * tabId 另外 new adapter，等于让同一个会话存在两套输出目标。
 */
export interface TabSessionHost {
	/** 创建一个该 tab 专属的会话（输出经 viewSink 投影到该 tab）。 */
	newSession(cwd: string, tabId: TabId): OpenCodeSession | null;
	/** 会话自持的回调适配器（登记进 TabRecord）。 */
	adapterOf(session: OpenCodeSession): SessionCallbackAdapter | null;
	/** 会话自持的流合并器（切 tab 回放时用它冲刷快照）。 */
	coalescerOf(session: OpenCodeSession): StreamMessageCoalescer | null;
}

export interface PreparedTabSession {
	tab: TabRecord;
	session: OpenCodeSession | null;
	created: boolean;
}

export type SessionConfigurer = (session: OpenCodeSession) => void;

/**
 * Creates and binds the resources of one tab's session.
 */
export class TabSessionFactory {
	constructor(
		private readonly registry: TabRegistry,
		private readonly host: TabSessionHost,
	) {}

	/**
	 * Ensure the tab exists and has a provisional session for its first send.
	 */
	prepare(tabId: TabId, cwd: string = '', configurer?: SessionConfigurer): PreparedTabSession {
		const record = this.registry.create(tabId, cwd);
		const existing = record.getSession();
		if (existing) {
			return { tab: record, session: existing, created: false };
		}

		const session = this.host.newSession(cwd, tabId);
		if (!session) {
			return { tab: record, session: null, created: false };
		}
		if (configurer) {
			configurer(session);
		}
		const adapter = this.host.adapterOf(session);
		const coalescer = this.host.coalescerOf(session);
		if (adapter) {
			adapter.setTabId(tabId.value);
		}
		record.attachPendingSession(session, adapter, coalescer);
		this.registry.markCreating(tabId);
		return { tab: record, session, created: true };
	}

	/**
	 * Bind a history session to a tab.
	 */
	attach(
		tabId: TabId,
		canonicalSessionId: string,
		session: OpenCodeSession,
		adapter: SessionCallbackAdapter | null,
		coalescer: StreamMessageCoalescer | null,
		cwd: string = '',
	): TabRecord {
		if (!session) {
			throw new Error('session is required');
		}
		const record = this.registry.create(tabId, cwd);
		const next = SessionId.of(canonicalSessionId);
		const current = record.getSessionId();
		if (current && !current.equals(next)) {
			throw new Error(`tab ${tabId.value} is already bound to ${current.value}`);
		}

		const effectiveAdapter = adapter || this.host.adapterOf(session) || record.getAdapter();
		const effectiveCoalescer = coalescer || this.host.coalescerOf(session) || record.getCoalescer();
		if (effectiveAdapter) {
			effectiveAdapter.setTabId(tabId.value);
			effectiveAdapter.setSessionId(canonicalSessionId);
			session.setCallback(effectiveAdapter);
		}
		if (effectiveCoalescer) {
			effectiveCoalescer.setTabId(tabId.value);
			effectiveCoalescer.setSessionId(canonicalSessionId);
		}

		this.registry.bind(tabId, canonicalSessionId, session, effectiveAdapter, effectiveCoalescer);
		this.registry.markLoadingHistory(tabId);
		return record;
	}

	/**
	 * Bind a known canonical session (history / fork) to a tab, creating the
	 * session when the tab has none yet.
	 */
	attachSession(
		tabId: TabId,
		canonicalSessionId: string,
		cwd: string = '',
		configurer?: SessionConfigurer,
	): TabRecord {
		const record = this.registry.create(tabId, cwd);
		const next = SessionId.of(canonicalSessionId);
		const current = record.getSessionId();
		if (current && !current.equals(next)) {
			throw new Error(`tab ${tabId.value} is already bound to ${current.value}`);
		}

		const session = record.getSession() || this.host.newSession(cwd, tabId);
		if (!session) {
			throw new Error(`no session available for tab ${tabId.value}`);
		}
		session.getState().setSessionId(canonicalSessionId);
		if (configurer) {
			configurer(session);
		}

		const coalescer = record.getCoalescer() || this.host.coalescerOf(session);
		const adapter = record.getAdapter() || this.host.adapterOf(session);

		if (adapter) {
			adapter.setTabId(tabId.value);
			adapter.setSessionId(canonicalSessionId);
			session.setCallback(adapter);
		}
		if (coalescer) {
			coalescer.setTabId(tabId.value);
			coalescer.setSessionId(canonicalSessionId);
		}

		this.registry.bind(tabId, canonicalSessionId, session, adapter, coalescer);
		this.registry.markLoadingHistory(tabId);
		return record;
	}
}
