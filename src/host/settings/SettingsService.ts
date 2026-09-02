/**
 * SettingsService — port of cc-gui `settings/CodemossSettingsService` +
 * `ProjectConfigHandler` config persistence.
 *
 * VS Code 里没有 PropertiesComponent；改用宿主注入的同步 Store（
 * extension.ts 里用 workspaceState / globalState Memento 实现），
 * 项目级配置以 `project:<rootPath>:<key>` 键隔离，全局配置平铺。
 */
export interface SettingsStore {
	getGlobal(key: string): unknown;
	setGlobal(key: string, value: unknown): void;
	getWorkspace(key: string): unknown;
	setWorkspace(key: string, value: unknown): void;
}

export const DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;

/**
 * Webview 外观 / 行为偏好。
 *
 * 这些项历史上只写 webview 的 localStorage，VS Code 重建 webview（切标签页、
 * 重载窗口、换工作区）后就会丢失，表现为「设置过但重启后又变回默认」。
 * 现在宿主持有权威副本：webview 启动时由 HTML 内联脚本先落地一次（避免首屏
 * 主题闪烁），随后 `get_ui_preferences` 回灌，改动经 `set_ui_preferences` 合并写回。
 */
export interface UiPreferences {
	/** 'system' = 跟随 VS Code 主题。 */
	theme: 'light' | 'dark' | 'system';
	/** 1..6，见 webview fontSizeMap（2 = 90%）。 */
	fontSizeLevel: number;
	chatBgColor: string;
	userMsgColor: string;
	chatBarColor: string;
	/** diffTheme：'follow' | 'editor' | 'light' | 'soft-dark'。 */
	diffTheme: string;
	diffExpandedByDefault: boolean;
	historyCompletionEnabled: boolean;
	skipNewSessionConfirm: boolean;
	detailedOutputEnabled: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
	theme: 'system',
	fontSizeLevel: 2,
	chatBgColor: '',
	userMsgColor: '',
	chatBarColor: '',
	diffTheme: 'follow',
	diffExpandedByDefault: false,
	historyCompletionEnabled: true,
	skipNewSessionConfirm: false,
	detailedOutputEnabled: false,
};

const UI_PREFERENCES_KEY = 'uiPreferences';
/** opencode 模型目录缓存（避免每次打开插件都等一轮 daemon round-trip）。 */
const CLI_MODELS_CACHE_KEY = 'opencode.cliModelsCache';

export class SettingsService {
	private workspaceRoots: string[];

	constructor(
		private readonly store: SettingsStore,
		workspaceRoots: string[] = [],
	) {
		this.workspaceRoots = workspaceRoots;
	}

	/** 首个 workspace 根（等价 cc-gui `project.getBasePath()`）。 */
	getPrimaryWorkspaceRoot(): string | null {
		return this.workspaceRoots.length > 0 ? this.workspaceRoots[0] : null;
	}

	/** 底层存储（供 handlers 持久化任意扩展数据，如会话索引）。 */
	getStore(): SettingsStore {
		return this.store;
	}

	setWorkspaceRoots(roots: string[]): void {
		this.workspaceRoots = roots;
	}

	// ── Working Directory ─────────────────────────────────────────────────

	getCustomWorkingDirectory(projectPath: string): string | null {
		const value = this.store.getWorkspace(`workingDirectory:${projectPath}`);
		return typeof value === 'string' && value !== '' ? value : null;
	}

	setCustomWorkingDirectory(projectPath: string, customWorkingDir: string | null): void {
		this.store.setWorkspace(`workingDirectory:${projectPath}`, customWorkingDir ?? '');
	}

	/**
	 * 生效工作目录：优先用户自定义（配置且为存在的目录），否则取首个 workspace 根。
	 * 供 SessionHandler / HandlerContext 决定 daemon cwd。
	 */
	getEffectiveWorkingDirectory(): string | null {
		const projectPath = this.getPrimaryWorkspaceRoot();
		if (projectPath) {
			const custom = this.getCustomWorkingDirectory(projectPath);
			if (custom && custom.trim() !== '') {
				return custom;
			}
		}
		return projectPath;
	}

	// ── 布尔开关 ─────────────────────────────────────────────────────────

	getAutoOpenFileEnabled(projectPath: string): boolean {
		const value = this.store.getWorkspace(`autoOpenFileEnabled:${projectPath}`);
		return value === true;
	}

	setAutoOpenFileEnabled(projectPath: string, enabled: boolean): void {
		this.store.setWorkspace(`autoOpenFileEnabled:${projectPath}`, enabled);
	}

	// ── 权限对话框超时（全局）─────────────────────────────────────────────

	getPermissionDialogTimeoutSeconds(): number {
		const value = this.store.getGlobal('permissionDialogTimeoutSeconds');
		return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
	}

	setPermissionDialogTimeoutSeconds(seconds: number): void {
		this.store.setGlobal('permissionDialogTimeoutSeconds', seconds);
	}

	// ── 发送快捷键（全局）─────────────────────────────────────────────────

	getSendShortcut(): string {
		const value = this.store.getGlobal('sendShortcut');
		return value === 'cmdEnter' ? 'cmdEnter' : 'enter';
	}

	setSendShortcut(shortcut: string): void {
		this.store.setGlobal('sendShortcut', shortcut === 'cmdEnter' ? 'cmdEnter' : 'enter');
	}

	// ── 用户语言（全局）───────────────────────────────────────────────────

	getUserLanguage(): string | null {
		const value = this.store.getGlobal('userLanguage');
		return typeof value === 'string' && value !== '' ? value : null;
	}

	setUserLanguage(language: string | null): void {
		this.store.setGlobal('userLanguage', language ?? '');
	}

	// ── 上次会话选择：模型 / 权限模式 / 推理力度（全局）────────────────────
	// webview localStorage 之外的双保险（VS Code 不保证 webview localStorage
	// 跨窗口重载保留）。frontend_ready 时回灌 SessionState，经
	// applyBackendTabState 推给前端恢复。

	getLastSelectedModel(): string | null {
		const value = this.store.getGlobal('lastSelectedModel');
		return typeof value === 'string' && value !== '' ? value : null;
	}

	setLastSelectedModel(model: string | null): void {
		this.store.setGlobal('lastSelectedModel', model ?? '');
	}

	getLastPermissionMode(): string | null {
		const value = this.store.getGlobal('lastPermissionMode');
		return typeof value === 'string' && value !== '' ? value : null;
	}

	setLastPermissionMode(mode: string | null): void {
		this.store.setGlobal('lastPermissionMode', mode ?? '');
	}

	getLastReasoningEffort(): string | null {
		const value = this.store.getGlobal('lastReasoningEffort');
		return typeof value === 'string' && value !== '' ? value : null;
	}

	setLastReasoningEffort(effort: string | null): void {
		this.store.setGlobal('lastReasoningEffort', effort ?? '');
	}

	// ── 声音通知（全局）───────────────────────────────────────────────────

	getSoundNotificationEnabled(): boolean {
		return this.store.getGlobal('soundNotificationEnabled') === true;
	}

	setSoundNotificationEnabled(enabled: boolean): void {
		this.store.setGlobal('soundNotificationEnabled', enabled);
	}

	getSoundOnlyWhenUnfocused(): boolean {
		return this.store.getGlobal('soundOnlyWhenUnfocused') === true;
	}

	setSoundOnlyWhenUnfocused(enabled: boolean): void {
		this.store.setGlobal('soundOnlyWhenUnfocused', enabled);
	}

	getSelectedSound(): string {
		const value = this.store.getGlobal('selectedSound');
		return typeof value === 'string' && value !== '' ? value : 'default';
	}

	setSelectedSound(soundId: string): void {
		this.store.setGlobal('selectedSound', soundId ?? 'default');
	}

	getCustomSoundPath(): string {
		const value = this.store.getGlobal('customSoundPath');
		return typeof value === 'string' ? value : '';
	}

	setCustomSoundPath(path: string): void {
		this.store.setGlobal('customSoundPath', path ?? '');
	}

	getTaskCompletionNotificationEnabled(): boolean {
		return this.store.getGlobal('taskCompletionNotificationEnabled') === true;
	}

	setTaskCompletionNotificationEnabled(enabled: boolean): void {
		this.store.setGlobal('taskCompletionNotificationEnabled', enabled);
	}

	getAskUserQuestionNotificationEnabled(): boolean {
		return this.store.getGlobal('askUserQuestionNotificationEnabled') === true;
	}

	setAskUserQuestionNotificationEnabled(enabled: boolean): void {
		this.store.setGlobal('askUserQuestionNotificationEnabled', enabled);
	}

	getSystemNotificationOnlyWhenUnfocused(): boolean {
		return this.store.getGlobal('systemNotificationOnlyWhenUnfocused') === true;
	}

	setSystemNotificationOnlyWhenUnfocused(enabled: boolean): void {
		this.store.setGlobal('systemNotificationOnlyWhenUnfocused', enabled);
	}

	getAskUserQuestionSoundNotificationEnabled(): boolean {
		return this.store.getGlobal('askUserQuestionSoundNotificationEnabled') === true;
	}

	setAskUserQuestionSoundNotificationEnabled(enabled: boolean): void {
		this.store.setGlobal('askUserQuestionSoundNotificationEnabled', enabled);
	}

	// ── UI 偏好（外观 / 行为，全局）──────────────────────────────────────
	//
	// 单一 JSON blob：字段多且常一起读写，拆成 N 个 key 只会让取值/校验逻辑
	// 重复 N 遍。读取时逐字段白名单校验，损坏字段回落到默认值。

	private static sanitize(prefs: Partial<UiPreferences> | null | undefined): UiPreferences {
		const raw = prefs && typeof prefs === 'object' ? prefs : {};
		const theme = raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
			? raw.theme
			: DEFAULT_UI_PREFERENCES.theme;
		const fontSizeLevel =
			typeof raw.fontSizeLevel === 'number' && Number.isFinite(raw.fontSizeLevel)
				? Math.min(6, Math.max(1, Math.trunc(raw.fontSizeLevel)))
				: DEFAULT_UI_PREFERENCES.fontSizeLevel;
		const color = (value: unknown): string =>
			typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '';
		const diffTheme =
			raw.diffTheme === 'follow' || raw.diffTheme === 'editor'
			|| raw.diffTheme === 'light' || raw.diffTheme === 'soft-dark'
				? raw.diffTheme
				: DEFAULT_UI_PREFERENCES.diffTheme;
		const bool = (value: unknown, fallback: boolean): boolean =>
			typeof value === 'boolean' ? value : fallback;
		return {
			theme,
			fontSizeLevel,
			chatBgColor: color(raw.chatBgColor),
			userMsgColor: color(raw.userMsgColor),
			chatBarColor: color(raw.chatBarColor),
			diffTheme,
			diffExpandedByDefault: bool(raw.diffExpandedByDefault, DEFAULT_UI_PREFERENCES.diffExpandedByDefault),
			historyCompletionEnabled: bool(raw.historyCompletionEnabled, DEFAULT_UI_PREFERENCES.historyCompletionEnabled),
			skipNewSessionConfirm: bool(raw.skipNewSessionConfirm, DEFAULT_UI_PREFERENCES.skipNewSessionConfirm),
			detailedOutputEnabled: bool(raw.detailedOutputEnabled, DEFAULT_UI_PREFERENCES.detailedOutputEnabled),
		};
	}

	getUiPreferences(): UiPreferences {
		const stored = this.store.getGlobal(UI_PREFERENCES_KEY);
		return SettingsService.sanitize(stored as Partial<UiPreferences> | null);
	}

	/** 合并写入（patch 只含变更字段），返回合并后的完整偏好。 */
	setUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
		const next = SettingsService.sanitize({ ...this.getUiPreferences(), ...patch });
		this.store.setGlobal(UI_PREFERENCES_KEY, next);
		return next;
	}

	// ── 模型目录缓存（全局）─────────────────────────────────────────────

	/**
	 * 上次成功拉取的模型目录 payload（原样缓存，直接回给 webview）。
	 * 用途：插件刚打开时先渲染缓存，再后台刷新，避免模型选择器空转数秒。
	 */
	getCachedCliModels(): Record<string, unknown> | null {
		const stored = this.store.getGlobal(CLI_MODELS_CACHE_KEY);
		if (!stored || typeof stored !== 'object') {
			return null;
		}
		const payload = stored as Record<string, unknown>;
		return Array.isArray(payload.models) ? payload : null;
	}

	setCachedCliModels(payload: Record<string, unknown>): void {
		this.store.setGlobal(CLI_MODELS_CACHE_KEY, payload);
	}
}

/** workspaceState/globalState Memento 的同步 Store 实现（宿主注入）。 */
export class MementoSettingsStore implements SettingsStore {
	constructor(
		private readonly workspaceState: { get: (k: string) => unknown; update: (k: string, v: unknown) => Thenable<void> },
		private readonly globalState: { get: (k: string) => unknown; update: (k: string, v: unknown) => Thenable<void> },
	) {}

	getGlobal(key: string): unknown {
		return this.globalState.get(key);
	}

	setGlobal(key: string, value: unknown): void {
		void this.globalState.update(key, value);
	}

	getWorkspace(key: string): unknown {
		return this.workspaceState.get(key);
	}

	setWorkspace(key: string, value: unknown): void {
		void this.workspaceState.update(key, value);
	}
}
