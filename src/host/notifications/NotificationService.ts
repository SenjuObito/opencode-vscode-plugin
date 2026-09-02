/**
 * NotificationService —— 把设置页的"通知/声音"开关接到真实触发点。
 *
 * 判定逻辑全部在宿主侧：能同步读 SettingsService 的权威持久化值，且可访问
 * vscode.window.state.focused 做"仅未聚焦时"门控；webview 只作为扬声器接收
 * `play_notification_sound` 推送（WebAudio 合成/解码播放）。
 *
 * 触发点：
 *   - OpenCodeSession.onTurnCompleted（extension.ts / ChatInstance.ts 两处装配）
 *     · completed → 任务完成系统通知 + 提示音（受任务完成通知开关/声音总开关控制）
 *     · error     → 警示通知（不受开关控制）+ 固定低沉双音
 *     · aborted   → 用户手动中断，静默
 *   - PermissionHandler.onQuestionRequested → AskUserQuestion 提醒通知/提示音
 */
import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import type { HandlerContext } from '../router/HandlerContext';
import { logDiagnostic } from '../util/DiagnosticLogger';

/** 宿主侧轻量文案表（webview i18n 不适用于系统通知场景）。 */
const COPY = {
	zh: {
		taskCompleted: '任务已完成',
		taskFailed: '任务执行出错',
		questionPending: 'opencode 等待你的输入',
	},
	'zh-TW': {
		taskCompleted: '任務已完成',
		taskFailed: '任務執行出錯',
		questionPending: 'opencode 等待你的輸入',
	},
	en: {
		taskCompleted: 'Task completed',
		taskFailed: 'Task failed',
		questionPending: 'opencode is waiting for your input',
	},
} as const;

type CopyKey = keyof typeof COPY;
type SoundKind = 'turnCompleted' | 'question' | 'error';

/** 自定义声音文件 base64 上限（约 5MB，超出直接回退默认音）。 */
const MAX_CUSTOM_SOUND_BYTES = 5 * 1024 * 1024;

export class NotificationService {
	constructor(private readonly context: HandlerContext) {}

	/** 流式 turn 结束：按状态分发完成/警示通知与提示音。 */
	onTurnCompleted(info: { status: 'completed' | 'aborted' | 'error' }): void {
		if (info.status === 'aborted') {
			return;
		}
		const settings = this.settings();
		if (info.status === 'error') {
			// 警示通知不受"任务完成通知"开关控制——出错必须让用户知道。
			this.showSystemNotification('taskFailed', vscode.window.showWarningMessage);
			this.playSoundIfEnabled('error', settings.getSoundNotificationEnabled());
			return;
		}
		if (settings.getTaskCompletionNotificationEnabled()) {
			this.showSystemNotification('taskCompleted', vscode.window.showInformationMessage);
		}
		this.playSoundIfEnabled('turnCompleted', settings.getSoundNotificationEnabled());
	}

	/** agent 发起 AskUserQuestion 时提醒用户（系统通知 + 提示音）。 */
	onQuestionRequested(): void {
		this.notifyPromptPending(true);
	}

	/** agent 发起权限请求时提醒用户（仅提示音——权限卡片本身已足够醒目）。 */
	onPermissionRequested(): void {
		this.notifyPromptPending(false);
	}

	/**
	 * 两类 prompt（AskUserQuestion / 权限审批）共用"提问提示音"开关 —— 与
	 * changelog 描述一致：permission / question prompts can play a sound。
	 * 不新增设置项，避免多语言文案与持久化键的扩散。
	 */
	private notifyPromptPending(withSystemNotification: boolean): void {
		const settings = this.settings();
		logDiagnostic(
			`[Notification] promptPending withSystemNotification=${withSystemNotification}`
			+ ` soundSwitch=${settings.getAskUserQuestionSoundNotificationEnabled()}`
			+ ` notificationSwitch=${settings.getAskUserQuestionNotificationEnabled()}`
			+ ` soundOnlyWhenUnfocused=${settings.getSoundOnlyWhenUnfocused()}`
			+ ` windowFocused=${vscode.window.state.focused}`,
		);
		if (withSystemNotification && settings.getAskUserQuestionNotificationEnabled()) {
			this.showSystemNotification('questionPending', vscode.window.showInformationMessage);
		}
		this.playSoundIfEnabled(
			'question',
			settings.getAskUserQuestionSoundNotificationEnabled(),
			settings.getSoundOnlyWhenUnfocused(),
		);
	}

	// ── 内部 ──────────────────────────────────────────────────────────────

	private settings() {
		return this.context.getSettingsService();
	}

	private copyKey(): CopyKey {
		const stored = (this.settings().getUserLanguage() ?? '').trim();
		if (stored === 'zh' || stored === 'zh-TW') {
			return stored;
		}
		return 'en';
	}

	/** 系统通知的"仅未聚焦时"门控。 */
	private shouldShowSystem(onlyWhenUnfocused: boolean): boolean {
		return !onlyWhenUnfocused || !vscode.window.state.focused;
	}

	private showSystemNotification(
		key: keyof (typeof COPY)['en'],
		show: (message: string) => unknown,
	): void {
		const settings = this.settings();
		if (!this.shouldShowSystem(settings.getSystemNotificationOnlyWhenUnfocused())) {
			return;
		}
		const copy = COPY[this.copyKey()];
		void show(copy[key]);
	}

	/** 声音门控：对应开关 + （默认用全局"声音仅未聚焦时"，可用参数覆盖）。 */
	private playSoundIfEnabled(kind: SoundKind, enabled: boolean, onlyWhenUnfocusedOverride?: boolean): void {
		if (!enabled) {
			logDiagnostic(`[Notification] sound skipped kind=${kind} reason=switchOff`);
			return;
		}
		const settings = this.settings();
		const gate = onlyWhenUnfocusedOverride ?? settings.getSoundOnlyWhenUnfocused();
		if (!this.shouldPlaySoundWhileFocused(gate)) {
			logDiagnostic(`[Notification] sound skipped kind=${kind} reason=onlyWhenUnfocused(windowFocused=${vscode.window.state.focused})`);
			return;
		}
		if (kind === 'error') {
			// 出错固定播低沉双音，不随 selectedSound 变化。
			this.pushSound({ variant: 'error' }, kind);
			return;
		}
		const soundId = settings.getSelectedSound() || 'default';
		if (soundId === 'custom') {
			const data = this.readCustomSoundBase64(settings.getCustomSoundPath());
			if (data) {
				this.pushSound({ soundId: 'custom', customDataBase64: data }, kind);
				return;
			}
			// 读取失败静默回退默认音
			this.pushSound({ soundId: 'default' }, kind);
			return;
		}
		this.pushSound({ soundId }, kind);
	}

	/** 统一下发播放指令并留痕，便于在输出通道定位"没响"的环节。 */
	private pushSound(payload: Record<string, unknown>, kind: SoundKind): void {
		const json = JSON.stringify(payload);
		logDiagnostic(`[Notification] sound push kind=${kind} payload=${json.slice(0, 140)}`);
		this.context.callJavaScript('playNotificationSound', json);
	}

	private shouldPlaySoundWhileFocused(onlyWhenUnfocused: boolean): boolean {
		return !onlyWhenUnfocused || !vscode.window.state.focused;
	}

	private readCustomSoundBase64(path: string | null): string | null {
		if (!path || !path.trim()) {
			return null;
		}
		try {
			const buf = readFileSync(path);
			if (buf.byteLength === 0 || buf.byteLength > MAX_CUSTOM_SOUND_BYTES) {
				return null;
			}
			return buf.toString('base64');
		} catch (err) {
			console.error('[NotificationService] Failed to read custom sound file:', err);
			return null;
		}
	}
}
