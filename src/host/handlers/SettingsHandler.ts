/**
 * SettingsHandler — port of cc-gui `handler/SettingsHandler.java` +
 * `PermissionModeHandler` + `ModelProviderHandler` + `ProjectConfigHandler`
 * (opencode-only subset).
 *
 * 保留对 webview 有意义的 type：
 *   get_mode / set_mode / set_model / set_reasoning_effort
 *   get_working_directory / set_working_directory
 *   get_send_shortcut / set_send_shortcut
 *   get_auto_open_file_enabled / set_auto_open_file_enabled
 *   get_permission_dialog_timeout / set_permission_dialog_timeout
 *   get_user_language / set_user_language / clear_user_language
 *   get_sound_notification_config / set_sound_notification_enabled / set_sound_only_when_unfocused / set_selected_sound / set_custom_sound_path / browse_sound_file
 *   get_task_completion_notification_enabled / set_task_completion_notification_enabled
 *   get_ask_user_question_notification_enabled / set_ask_user_question_notification_enabled
 *   get_system_notification_only_when_unfocused / set_system_notification_only_when_unfocused
 *   get_ask_user_question_sound_notification_enabled / set_ask_user_question_sound_notification_enabled
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { SettingsService, DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../settings/SettingsService';
import * as vscode from 'vscode';
import { isAbsolute, resolve } from 'path';
import { existsSync, statSync } from 'fs';

const SUPPORTED_TYPES = [
	'get_mode',
	'set_mode',
	'set_reasoning_effort',
	'get_ide_theme',
	'get_claude_cli_path',
	'set_claude_cli_path',
	'get_working_directory',
	'set_working_directory',
	'get_send_shortcut',
	'set_send_shortcut',
	'get_auto_open_file_enabled',
	'set_auto_open_file_enabled',
	'get_permission_dialog_timeout',
	'set_permission_dialog_timeout',
	'get_user_language',
	'set_user_language',
	'clear_user_language',
	'get_sound_notification_config',
	'set_sound_notification_enabled',
	'set_sound_only_when_unfocused',
	'set_selected_sound',
	'set_custom_sound_path',
	'browse_sound_file',
	'get_task_completion_notification_enabled',
	'set_task_completion_notification_enabled',
	'get_ask_user_question_notification_enabled',
	'set_ask_user_question_notification_enabled',
	'get_system_notification_only_when_unfocused',
	'set_system_notification_only_when_unfocused',
	'get_ask_user_question_sound_notification_enabled',
	'set_ask_user_question_sound_notification_enabled',
	'get_ui_preferences',
	'set_ui_preferences',
];

/** opencode TUI 自定义二进制路径的全局存储键（wire 协议名仍为 claude_cli_path）。 */
const CLI_PATH_STORAGE_KEY = 'opencode.tuiPath';

export class SettingsHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_mode':
				this.handleGetMode();
				return true;
			case 'set_mode':
				this.handleSetMode(content);
				return true;
			case 'set_reasoning_effort':
				this.handleSetReasoningEffort(content);
				return true;
			case 'get_ide_theme':
				this.handleGetIdeTheme();
				return true;
			case 'get_claude_cli_path':
				this.handleGetCliPath();
				return true;
			case 'set_claude_cli_path':
				this.handleSetCliPath(content);
				return true;
			case 'get_working_directory':
				this.handleGetWorkingDirectory();
				return true;
			case 'set_working_directory':
				this.handleSetWorkingDirectory(content);
				return true;
			case 'get_send_shortcut':
				this.handleGetSendShortcut();
				return true;
			case 'set_send_shortcut':
				this.handleSetSendShortcut(content);
				return true;
			case 'get_auto_open_file_enabled':
				this.handleGetAutoOpenFileEnabled();
				return true;
			case 'set_auto_open_file_enabled':
				this.handleSetAutoOpenFileEnabled(content);
				return true;
			case 'get_permission_dialog_timeout':
				this.handleGetPermissionDialogTimeout();
				return true;
			case 'set_permission_dialog_timeout':
				this.handleSetPermissionDialogTimeout(content);
				return true;
			case 'get_user_language':
				this.handleGetUserLanguage();
				return true;
			case 'set_user_language':
				this.handleSetUserLanguage(content);
				return true;
		case 'clear_user_language':
			this.handleClearUserLanguage();
			return true;
		case 'get_sound_notification_config':
			this.handleGetSoundNotificationConfig();
			return true;
		case 'set_sound_notification_enabled':
			this.handleSetSoundNotificationEnabled(content);
			return true;
		case 'set_sound_only_when_unfocused':
			this.handleSetSoundOnlyWhenUnfocused(content);
			return true;
		case 'set_selected_sound':
			this.handleSetSelectedSound(content);
			return true;
		case 'set_custom_sound_path':
			this.handleSetCustomSoundPath(content);
			return true;
		case 'browse_sound_file':
			this.handleBrowseSoundFile();
			return true;
		case 'get_task_completion_notification_enabled':
			this.handleGetTaskCompletionNotificationEnabled();
			return true;
		case 'set_task_completion_notification_enabled':
			this.handleSetTaskCompletionNotificationEnabled(content);
			return true;
		case 'get_ask_user_question_notification_enabled':
			this.handleGetAskUserQuestionNotificationEnabled();
			return true;
		case 'set_ask_user_question_notification_enabled':
			this.handleSetAskUserQuestionNotificationEnabled(content);
			return true;
		case 'get_system_notification_only_when_unfocused':
			this.handleGetSystemNotificationOnlyWhenUnfocused();
			return true;
		case 'set_system_notification_only_when_unfocused':
			this.handleSetSystemNotificationOnlyWhenUnfocused(content);
			return true;
		case 'get_ask_user_question_sound_notification_enabled':
			this.handleGetAskUserQuestionSoundNotificationEnabled();
			return true;
		case 'set_ask_user_question_sound_notification_enabled':
			this.handleSetAskUserQuestionSoundNotificationEnabled(content);
			return true;
		case 'get_ui_preferences':
			this.pushUiPreferences();
			return true;
		case 'set_ui_preferences':
			this.handleSetUiPreferences(content);
			return true;
		default:
			return false;
		}
	}

	// ── helpers ────────────────────────────────────────────────────────────

	private settings(): SettingsService {
		return this.context.getSettingsService();
	}

	private projectPath(): string | null {
		return this.settings().getPrimaryWorkspaceRoot();
	}

	private pushJson(callback: string, payload: Record<string, unknown>): void {
		this.callJavaScript(callback, JSON.stringify(payload));
	}

	// ── permission mode ────────────────────────────────────────────────────

	private handleGetMode(): void {
		const session = this.context.getSession();
		let mode = 'default';
		if (session && session.state.getPermissionMode() && session.state.getPermissionMode().trim() !== '') {
			mode = session.state.getPermissionMode();
		}
		this.callJavaScript('onModeReceived', mode);
	}

	private handleSetMode(content: string): void {
		let mode = content;
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json?.mode === 'string') {
				mode = json.mode;
			}
		} catch {
			// content 本身即 mode
		}

		const session = this.context.getSession();
		if (!session) {
			return;
		}
		session.state.setPermissionMode(mode);
		// workspaceState 权威持久化（重启后 frontend_ready 回灌 SessionState）
		if (mode.trim() !== '') {
			this.settings().setLastPermissionMode(mode);
		}
		// 前端已做乐观更新，这里再回推权威值
		this.callJavaScript('onModeChanged', session.state.getPermissionMode());
	}

	// ── model / reasoning effort ───────────────────────────────────────────

	// set_model 由 ModelProviderHandler 处理（cc-gui ModelProviderHandler 移植）。

	/** VS Code 主题跟随：webview 启动时会发 get_ide_theme 询问当前深浅色。 */
	private handleGetIdeTheme(): void {
		const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
		this.callJavaScript('onIdeThemeReceived', JSON.stringify({ isDark }));
	}

	// ── opencode TUI 路径（wire 协议沿用 claude_cli_path 名，语义为 opencode 二进制）──

	private getCliPathSetting(): string {
		const value = this.settings().getStore().getGlobal(CLI_PATH_STORAGE_KEY);
		return typeof value === 'string' ? value : '';
	}

	private handleGetCliPath(): void {
		this.callJavaScript('updateClaudeCliPath', JSON.stringify({ path: this.getCliPathSetting() }));
	}

	private handleSetCliPath(content: string): void {
		let path = '';
		try {
			const json = JSON.parse(content ?? '') as { path?: unknown };
			if (typeof json?.path === 'string') {
				path = json.path.trim();
			}
		} catch {
			// 无 JSON 载荷
		}

		if (path !== '' && !existsSync(path)) {
			this.callJavaScript('showError', `Opencode binary not found: ${path}`);
			// 回显旧值，前端输入框与实际存储保持一致
			this.callJavaScript('updateClaudeCliPath', JSON.stringify({ path: this.getCliPathSetting() }));
			return;
		}

		this.settings().getStore().setGlobal(CLI_PATH_STORAGE_KEY, path);
		this.callJavaScript('updateClaudeCliPath', JSON.stringify({ path }));
		this.callJavaScript(
			'showSuccess',
			path
				? 'Opencode TUI path saved. Restarting daemon to apply...'
				: 'Opencode TUI path cleared. Restarting daemon to auto-detect...',
		);

		// 重启 daemon 使注入的 OPENCODE_BIN 生效（懒式：下次请求时重新拉起 serve）。
		const daemon = this.context.getDaemon();
		if (daemon) {
			daemon.stop();
			void daemon.start().then((started) => {
				if (!started) {
					this.callJavaScript('showError', 'Daemon failed to restart after saving opencode path');
				}
			});
		}
	}

	private handleSetReasoningEffort(content: string): void {
		let effort = content;
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json?.reasoningEffort === 'string') {
				effort = json.reasoningEffort;
			}
		} catch {
			// content 本身即 effort
		}
		const session = this.context.getSession();
		if (session) {
			session.state.setReasoningEffort(effort);
		}
		// workspaceState 权威持久化（重启后 frontend_ready 回灌 SessionState）
		if (effort.trim() !== '') {
			this.settings().setLastReasoningEffort(effort);
		}
	}

	// ── working directory ──────────────────────────────────────────────────

	private handleGetWorkingDirectory(): void {
		const projectPath = this.projectPath();
		if (!projectPath) {
			this.callJavaScript('updateWorkingDirectory', '{}');
			return;
		}
		const custom = this.settings().getCustomWorkingDirectory(projectPath);
		this.pushJson('updateWorkingDirectory', {
			projectPath,
			customWorkingDir: custom ?? '',
		});
	}

	private handleSetWorkingDirectory(content: string): void {
		const projectPath = this.projectPath();
		if (!projectPath) {
			this.callJavaScript('showError', 'Unable to resolve project path');
			return;
		}
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			let customWorkingDir = typeof json?.customWorkingDir === 'string' ? json.customWorkingDir : null;
			if (customWorkingDir && customWorkingDir.trim() !== '') {
				customWorkingDir = customWorkingDir.trim();
				const finalPath = isAbsolute(customWorkingDir) ? customWorkingDir : resolve(projectPath, customWorkingDir);
				if (!existsSync(finalPath) || !statSync(finalPath).isDirectory()) {
					this.callJavaScript('showError', `Working directory does not exist: ${finalPath}`);
					return;
				}
			}
			this.settings().setCustomWorkingDirectory(projectPath, customWorkingDir);
			this.callJavaScript('showSuccess', 'Working directory config saved');
		} catch (ex) {
			this.callJavaScript('showError', `Failed to save working directory config: ${String(ex)}`);
		}
	}

	// ── send shortcut ──────────────────────────────────────────────────────

	private handleGetSendShortcut(): void {
		this.pushJson('updateSendShortcut', { sendShortcut: this.settings().getSendShortcut() });
	}

	private handleSetSendShortcut(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const sendShortcut = typeof json?.sendShortcut === 'string' ? json.sendShortcut : 'enter';
			this.settings().setSendShortcut(sendShortcut);
			this.pushJson('updateSendShortcut', { sendShortcut: this.settings().getSendShortcut() });
		} catch {
			this.callJavaScript('showError', 'Failed to save send shortcut setting');
		}
	}

	// ── auto open file ─────────────────────────────────────────────────────

	private handleGetAutoOpenFileEnabled(): void {
		const projectPath = this.projectPath();
		const enabled = projectPath != null && this.settings().getAutoOpenFileEnabled(projectPath);
		this.pushJson('updateAutoOpenFileEnabled', { autoOpenFileEnabled: enabled });
	}

	private handleSetAutoOpenFileEnabled(content: string): void {
		const projectPath = this.projectPath();
		if (!projectPath) {
			this.callJavaScript('showError', 'Unable to resolve project path');
			return;
		}
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.autoOpenFileEnabled === true;
			this.settings().setAutoOpenFileEnabled(projectPath, enabled);
			// 同步清空编辑器上下文缓存：tracker 的 lastInfo 只在编辑器事件时重算，
			// 若不在此处清除，关闭后立即发送仍会把过期的 @file 注入消息。
			if (!enabled) {
				this.context.clearEditorContext();
			} else {
				// 启用时立即推送当前编辑器上下文，否则需等到下一次文件切换才显示。
				this.context.pushEditorContext();
			}
			this.pushJson('updateAutoOpenFileEnabled', { autoOpenFileEnabled: enabled });
		} catch {
			this.callJavaScript('showError', 'Failed to save auto open file config');
		}
	}

	// ── permission dialog timeout ──────────────────────────────────────────

	private handleGetPermissionDialogTimeout(): void {
		this.pushJson('updatePermissionDialogTimeout', {
			permissionDialogTimeoutSeconds: this.settings().getPermissionDialogTimeoutSeconds(),
		});
	}

	private handleSetPermissionDialogTimeout(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const raw = json?.permissionDialogTimeoutSeconds;
			let seconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				seconds = Math.trunc(raw);
			}
			this.settings().setPermissionDialogTimeoutSeconds(seconds);
			this.pushJson('updatePermissionDialogTimeout', {
				permissionDialogTimeoutSeconds: this.settings().getPermissionDialogTimeoutSeconds(),
			});
		} catch {
			this.callJavaScript('showError', 'Failed to save permission dialog timeout.');
		}
	}

	// ── user language ──────────────────────────────────────────────────────

	private handleGetUserLanguage(): void {
		this.pushLanguageConfig();
	}

	private handleSetUserLanguage(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const language = typeof json?.language === 'string' ? json.language : '';
			if (!language.trim()) {
				this.callJavaScript('showError', 'Empty language rejected');
				return;
			}
			this.settings().setUserLanguage(language);
			this.pushLanguageConfig();
		} catch {
			this.callJavaScript('showError', 'Failed to save user language');
		}
	}

	private handleClearUserLanguage(): void {
		this.settings().setUserLanguage(null);
		this.pushLanguageConfig();
	}

	/**
	 * 把权威语言配置回推 webview。统一走 `applyIdeaLanguageConfig`——webview
	 * 侧该回调会 changeLanguage + 写 localStorage + 广播 resync 事件。
	 * （历史遗留：曾推 `onUserLanguage`，但 webview 从未定义该回调，回推被
	 * 静默丢弃，是"重启后语言不生效"的断点之一。）
	 */
	private pushLanguageConfig(): void {
		pushUserLanguageConfig((fn, ...args) => this.callJavaScript(fn, ...args), this.settings());
	}

	// ── 声音通知配置 ──────────────────────────────────────────────────────

	private handleGetSoundNotificationConfig(): void {
		const s = this.settings();
		this.pushJson('updateSoundNotificationConfig', {
			enabled: s.getSoundNotificationEnabled(),
			onlyWhenUnfocused: s.getSoundOnlyWhenUnfocused(),
			selectedSound: s.getSelectedSound(),
			customSoundPath: s.getCustomSoundPath(),
		});
	}

	private handleSetSoundNotificationEnabled(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.enabled === true;
			this.settings().setSoundNotificationEnabled(enabled);
		} catch { /* 静默忽略 */ }
	}

	private handleSetSoundOnlyWhenUnfocused(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.onlyWhenUnfocused === true;
			this.settings().setSoundOnlyWhenUnfocused(enabled);
		} catch { /* 静默忽略 */ }
	}

	private handleSetSelectedSound(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const soundId = typeof json?.soundId === 'string' ? json.soundId : 'default';
			this.settings().setSelectedSound(soundId);
		} catch { /* 静默忽略 */ }
	}

	private handleSetCustomSoundPath(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const path = typeof json?.path === 'string' ? json.path : '';
			this.settings().setCustomSoundPath(path);
		} catch { /* 静默忽略 */ }
	}

	/** 自定义声音"浏览"：原生文件选择对话框，选完回填 webview 输入框（不落盘）。 */
	private handleBrowseSoundFile(): void {
		void vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Select sound file',
			filters: {
				Audio: ['wav', 'mp3', 'aiff', 'm4a', 'ogg', 'flac'],
			},
		}).then((uris) => {
			const path = uris?.[0]?.fsPath;
			if (!path) {
				return;
			}
			this.pushJson('onSoundFileSelected', { path });
		});
	}

	private handleGetTaskCompletionNotificationEnabled(): void {
		this.pushJson('updateTaskCompletionNotificationEnabled', {
			taskCompletionNotificationEnabled: this.settings().getTaskCompletionNotificationEnabled(),
		});
	}

	private handleSetTaskCompletionNotificationEnabled(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.taskCompletionNotificationEnabled === true;
			this.settings().setTaskCompletionNotificationEnabled(enabled);
			this.pushJson('updateTaskCompletionNotificationEnabled', { taskCompletionNotificationEnabled: enabled });
		} catch { /* 静默忽略 */ }
	}

	private handleGetAskUserQuestionNotificationEnabled(): void {
		this.pushJson('updateAskUserQuestionNotificationEnabled', {
			askUserQuestionNotificationEnabled: this.settings().getAskUserQuestionNotificationEnabled(),
		});
	}

	private handleSetAskUserQuestionNotificationEnabled(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.askUserQuestionNotificationEnabled === true;
			this.settings().setAskUserQuestionNotificationEnabled(enabled);
			this.pushJson('updateAskUserQuestionNotificationEnabled', { askUserQuestionNotificationEnabled: enabled });
		} catch { /* 静默忽略 */ }
	}

	private handleGetSystemNotificationOnlyWhenUnfocused(): void {
		this.pushJson('updateSystemNotificationOnlyWhenUnfocused', {
			systemNotificationOnlyWhenUnfocused: this.settings().getSystemNotificationOnlyWhenUnfocused(),
		});
	}

	private handleSetSystemNotificationOnlyWhenUnfocused(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.systemNotificationOnlyWhenUnfocused === true;
			this.settings().setSystemNotificationOnlyWhenUnfocused(enabled);
			this.pushJson('updateSystemNotificationOnlyWhenUnfocused', { systemNotificationOnlyWhenUnfocused: enabled });
		} catch { /* 静默忽略 */ }
	}

	private handleGetAskUserQuestionSoundNotificationEnabled(): void {
		this.pushJson('updateAskUserQuestionSoundNotificationEnabled', {
			askUserQuestionSoundNotificationEnabled: this.settings().getAskUserQuestionSoundNotificationEnabled(),
		});
	}

	private handleSetAskUserQuestionSoundNotificationEnabled(content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const enabled = json?.askUserQuestionSoundNotificationEnabled === true;
			this.settings().setAskUserQuestionSoundNotificationEnabled(enabled);
			this.pushJson('updateAskUserQuestionSoundNotificationEnabled', { askUserQuestionSoundNotificationEnabled: enabled });
		} catch { /* 静默忽略 */ }
	}

	// ── UI 偏好（主题 / 字号 / 配色 / diff / 行为开关）───────────────────

	/**
	 * webview 启动时拉取权威偏好。这些字段原本只存在于 webview localStorage，
	 * VS Code 重建 webview 后即丢失；现在宿主是唯一权威源。
	 * 回包走 `applyUiPreferences`，webview 侧统一入口负责写 DOM + 广播。
	 */
	private pushUiPreferences(): void {
		pushUiPreferences((fn, ...args) => this.callJavaScript(fn, ...args), this.settings());
	}

	private handleSetUiPreferences(content: string): void {
		let patch: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (parsed && typeof parsed === 'object') {
				patch = parsed;
			}
		} catch {
			return;
		}
		this.settings().setUiPreferences(patch);
		// 回推归一化后的完整值，保证 webview 与宿主一致（非法输入会被纠正）。
		this.pushUiPreferences();
	}
}

/** 推送权威 UI 偏好（frontend_ready 与 get/set_ui_preferences 共用）。 */
export function pushUiPreferences(
	callJavaScript: (functionName: string, ...args: string[]) => void,
	settings: SettingsService,
): void {
	callJavaScript('applyUiPreferences', JSON.stringify(settings.getUiPreferences()));
}

/** webview i18n 支持的语言码（与 webview/src/i18n/config.ts resources 一致）。 */
const SUPPORTED_LANGUAGES = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'];

/**
 * IDE 界面语言（vscode.env.language，如 zh-cn / zh-tw / en）→ 支持的语言码。
 * "跟随 IDE" 兜底：用户未手动设置语言时使用。无法识别时回退英文。
 */
export function mapIdeLanguageToSupported(ideLanguage: string): string {
	const lower = (ideLanguage ?? '').trim().toLowerCase();
	if (!lower) {
		return 'en';
	}
	const exact = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === lower);
	if (exact) {
		return exact;
	}
	// 中文变体：zh-cn/zh-sg → zh；zh-tw/zh-hk/zh-hant → zh-TW
	if (lower.startsWith('zh')) {
		return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh';
	}
	const base = lower.split('-')[0];
	return SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === base) ?? 'en';
}

/**
 * 推送权威语言配置给 webview：
 * 1. 用户手动设置过（globalState userLanguage）→ source: 'user'；
 * 2. 未设置 → 跟随 IDE 界面语言（source: 'idea'）。
 * webview 的 applyIdeaLanguageConfig 负责 changeLanguage + localStorage 持久化。
 * frontend_ready 与 get/set/clear_user_language 三条路径共用，保证任何时点
 * webview 收到的都是同一份权威值。
 */
export function pushUserLanguageConfig(
	callJavaScript: (functionName: string, ...args: string[]) => void,
	settings: SettingsService,
): void {
	const stored = settings.getUserLanguage();
	if (stored && stored.trim()) {
		callJavaScript('applyIdeaLanguageConfig', JSON.stringify({ language: stored.trim(), source: 'user' }));
		return;
	}
	callJavaScript(
		'applyIdeaLanguageConfig',
		JSON.stringify({ language: mapIdeLanguageToSupported(vscode.env.language), source: 'idea' }),
	);
}
