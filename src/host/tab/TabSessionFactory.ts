import { TabRegistry } from './TabRegistry';
import { TabRecord } from './TabRecord';
import { TabId } from './TabId';
import { SessionId } from './SessionId';
import type { OpenCodeSession } from '../session/OpenCodeSession';
import type { SessionCallbackAdapter } from '../session/SessionCallbackAdapter';
import type { StreamMessageCoalescer } from '../session/StreamMessageCoalescer';

export interface TabSessionHost {
	newSession(cwd: string): OpenCodeSession;
	newCoalescer(tabId: TabId): StreamMessageCoalescer;
	newAdapter(tabId: TabId, coalescer: StreamMessageCoalescer): SessionCallbackAdapter;
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

		const session = this.host.newSession(cwd);
		if (!session) {
			return { tab: record, session: null, created: false };
		}
		if (configurer) {
			configurer(session);
		}
		const coalescer = this.host.newCoalescer(tabId);
		const adapter = this.host.newAdapter(tabId, coalescer);
		if (adapter) {
			session.setCallback(adapter);
		}
		record.setSessionResources(null as unknown as SessionId, session, adapter, coalescer);
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

		const effectiveAdapter = adapter || record.getAdapter();
		const effectiveCoalescer = coalescer || record.getCoalescer();
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
	 * Bind a known canonical session (e.g. from fork) to a tab.
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

		const session = record.getSession() || this.host.newSession(cwd);
		session.getState().setSessionId(canonicalSessionId);
		if (configurer) {
			configurer(session);
		}

		const coalescer = record.getCoalescer() || this.host.newCoalescer(tabId);
		const adapter = record.getAdapter() || this.host.newAdapter(tabId, coalescer);

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
