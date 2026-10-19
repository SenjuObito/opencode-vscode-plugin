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
import type { ChatMessage } from '../session/types';
import { logDiagnostic } from '../util/DiagnosticLogger';
import { COPY, type CopyKey, resolveCopyKey } from './NotificationCopy';

export { COPY, type CopyKey, resolveCopyKey };

type SoundKind = 'turnCompleted' | 'question' | 'error';
const MAX_CUSTOM_SOUND_BYTES = 5 * 1024 * 1024;
/** 通知正文上限（idea `SystemNotificationService` 同量级）。 */
const PREVIEW_MAX_CHARS = 220;
/** 压缩前最多看这么多字符，避免对整份长回复跑正则。 */
const CONDENSE_MAX_INPUT = 4000;
const VIEW_ACTION = 'View';

/**
 * 通知标题：`【会话名】任务已完成`；没有会话名时退化为纯文案
 * （idea `OpencodeNotifier.buildTitleFromSession`）。
 */
export function buildNotificationTitle(sessionName: string | null | undefined, fallback: string): string {
	const name = typeof sessionName === 'string' ? sessionName.trim() : '';
	return name ? `【${name}】${fallback}` : fallback;
}

/**
 * 从最后一条 assistant 消息里摘出可读摘要。
 *
 * 优先取 raw 里**最后一个 text block**：工具轮次中 `content` 会把工具调用前的
 * 说明文字一起拼进来，直接用它当摘要会显示「我这就去检查……」而不是最终答复。
 */
export function buildNotificationPreview(
	messages: readonly ChatMessage[] | undefined,
	fallback: string,
): string {
	if (!messages || messages.length === 0) {
		return fallback;
	}
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || message.type !== 'assistant') {
			continue;
		}
		const rawText = extractLastTextFromRaw(message);
		const content = rawText && rawText.trim() !== '' ? rawText : message.content;
		if (!content || content.trim() === '') {
			// 纯工具调用的 assistant 帧没有文本，跳过它继续往前找。
			continue;
		}
		const preview = condenseForToast(content);
		if (preview !== '') {
			return preview;
		}
	}
	return fallback;
}

function extractLastTextFromRaw(message: ChatMessage): string | null {
	const raw = message.raw as Record<string, unknown> | string | undefined;
	if (!raw) {
		return null;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
	} catch {
		return null;
	}
	const container = (parsed.message && typeof parsed.message === 'object')
		? parsed.message as Record<string, unknown>
		: parsed;
	const blocks = container.content;
	if (!Array.isArray(blocks)) {
		return null;
	}
	let lastText: string | null = null;
	for (const block of blocks) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const obj = block as Record<string, unknown>;
		if (obj.type === 'text' && typeof obj.text === 'string') {
			lastText = obj.text;
		}
	}
	return lastText;
}

/** 折叠换行/代码围栏，压成一行适合通知面板阅读的文本。 */
function condenseForToast(raw: string): string {
	const input = raw.length > CONDENSE_MAX_INPUT ? raw.slice(0, CONDENSE_MAX_INPUT) : raw;
	const stripped = input
		.replace(/```[a-zA-Z0-9_+-]*\s*/g, '')
		.replace(/```/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return stripped.length > PREVIEW_MAX_CHARS
		? `${stripped.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
		: stripped;
}

export class NotificationService {
	constructor(private readonly context: HandlerContext) {}

	/** 流式 turn 结束：按状态分发完成/警示通知与提示音。 */
	onTurnCompleted(info: { status: 'completed' | 'aborted' | 'error'; sessionId?: string | null }): void {
		if (info.status === 'aborted') {
			return;
		}
		const settings = this.settings();
		if (info.status === 'error') {
			// 警示通知不受"任务完成通知"开关控制——出错必须让用户知道。
			this.showSystemNotification('taskFailed', vscode.window.showWarningMessage, info.sessionId);
			this.playSoundIfEnabled('error', settings.getSoundNotificationEnabled());
			return;
		}
		if (settings.getTaskCompletionNotificationEnabled()) {
			this.showSystemNotification('taskCompleted', vscode.window.showInformationMessage, info.sessionId);
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
		return resolveCopyKey(this.settings().getUserLanguage(), vscode.env.language);
	}

	/** 系统通知的"仅未聚焦时"门控。 */
	private shouldShowSystem(onlyWhenUnfocused: boolean): boolean {
		return !onlyWhenUnfocused || !vscode.window.state.focused;
	}

	private showSystemNotification(
		key: keyof (typeof COPY)['en'],
		show: (message: string, ...items: string[]) => Thenable<string | undefined>,
		sessionId?: string | null,
	): void {
		const settings = this.settings();
		if (!this.shouldShowSystem(settings.getSystemNotificationOnlyWhenUnfocused())) {
			return;
		}
		const copy = COPY[this.copyKey()];
		const session = sessionId ? this.context.getSession(sessionId) : null;
		const sessionName = session?.state.getSummary() ?? (sessionId ?? null);
		const title = buildNotificationTitle(sessionName, copy[key]);
		const preview = session
			? buildNotificationPreview(session.state.getMessages(), '')
			: '';
		const message = preview ? `${title}\n${preview}` : title;

		// 「查看」按钮：把对应会话带到前台（原生 panel reveal + 视图内 tab 切换）。
		// 没有 sessionId 时不给按钮——点了也没地方去。
		const items = sessionId ? [VIEW_ACTION] : [];
		void show(message, ...items).then((choice) => {
			if (choice !== VIEW_ACTION || !sessionId) {
				return;
			}
			const focused = this.context.focusSession(sessionId);
			logDiagnostic(`[Notification] view action for ${sessionId} focused=${focused}`);
		});
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
