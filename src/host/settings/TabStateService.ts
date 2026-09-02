/**
 * TabStateService — port of cc-gui `settings/TabStateService.java`.
 *
 * Persists per-tab metadata across restarts. cc-gui stores a `Map<index, name>`
 * and `Map<index, TabSessionState>` in project state; VS Code 用 workspaceState
 * 的同一 shape。opencode 前缀沿用品牌（"OpenCode Buddy"）。
 */
import { SettingsStore } from './SettingsService';

export interface TabSessionState {
	provider: string;
	sessionId: string | null;
	cwd: string | null;
	model: string | null;
	permissionMode: string;
	reasoningEffort: string | null;
}

interface PersistedState {
	tabNames: Record<string, string>;
	tabSessions: Record<string, TabSessionState | null>;
}

const TAB_STATE_KEY = 'opencode.tabState';

export class TabStateService {
	private readonly store: SettingsStore;

	constructor(store: SettingsStore) {
		this.store = store;
	}

	private read(): PersistedState {
		const raw = this.store.getWorkspace(TAB_STATE_KEY) as PersistedState | null;
		const state: PersistedState = raw && typeof raw === 'object' ? raw : { tabNames: {}, tabSessions: {} };
		if (!state.tabNames || typeof state.tabNames !== 'object') {
			state.tabNames = {};
		}
		if (!state.tabSessions || typeof state.tabSessions !== 'object') {
			state.tabSessions = {};
		}
		return state;
	}

	private write(state: PersistedState): void {
		this.store.setWorkspace(TAB_STATE_KEY, state);
	}

	getTabName(tabIndex: string): string | null {
		const name = this.read().tabNames[tabIndex];
		return typeof name === 'string' && name !== '' ? name : null;
	}

	saveTabName(tabIndex: string, tabName: string): void {
		if (!tabName || tabName.trim() === '') {
			return;
		}
		const state = this.read();
		state.tabNames[tabIndex] = tabName;
		this.write(state);
	}

	getTabSessionState(tabIndex: string): TabSessionState | null {
		const value = this.read().tabSessions[tabIndex];
		return value && typeof value === 'object' ? value : null;
	}

	saveTabSessionState(tabIndex: string, session: TabSessionState | null): void {
		const state = this.read();
		if (session == null) {
			delete state.tabSessions[tabIndex];
		} else {
			state.tabSessions[tabIndex] = {
				provider: session.provider,
				sessionId: session.sessionId,
				cwd: session.cwd,
				model: session.model,
				permissionMode: session.permissionMode,
				reasoningEffort: session.reasoningEffort,
			};
		}
		this.write(state);
	}

	/** 下一个标签页序号：扫描现有名字取最大后缀 +1（cc-gui getNextTabName）。 */
	getNextTabIndex(): string {
		const state = this.read();
		let max = 0;
		for (const index of Object.keys(state.tabNames)) {
			const match = /^(\d+)$/.exec(index);
			if (match) {
				const n = parseInt(match[1], 10);
				if (n > max) {
					max = n;
				}
			}
		}
		return String(max + 1);
	}

	/** 生成下一个标签页标题（cc-gui getNextTabName 的 "AI{n}" 版 → "OpenCode {n}"）。 */
	getNextTabName(): string {
		const index = this.getNextTabIndex();
		return index === '1' ? 'OpenCode Buddy' : `OpenCode Buddy ${index}`;
	}
}
