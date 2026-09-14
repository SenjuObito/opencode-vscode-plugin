export const SUPPORTED_LANGUAGES = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'] as const;

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

/** 宿主侧轻量文案表（webview i18n 不适用于系统通知场景）。 */
export const COPY = {
	zh: {
		taskCompleted: '任务已完成',
		taskFailed: '任务执行出错',
		questionPending: 'OpenCode Buddy 等待你的输入',
	},
	'zh-TW': {
		taskCompleted: '任務已完成',
		taskFailed: '任務執行出錯',
		questionPending: 'OpenCode Buddy 等待你的輸入',
	},
	en: {
		taskCompleted: 'Task completed',
		taskFailed: 'Task failed',
		questionPending: 'OpenCode Buddy is waiting for your input',
	},
	es: {
		taskCompleted: 'Tarea completada',
		taskFailed: 'Error en la tarea',
		questionPending: 'OpenCode Buddy está esperando tu respuesta',
	},
	fr: {
		taskCompleted: 'Tâche terminée',
		taskFailed: 'Échec de la tâche',
		questionPending: 'OpenCode Buddy attend votre réponse',
	},
	ja: {
		taskCompleted: 'タスク完了',
		taskFailed: 'タスク実行エラー',
		questionPending: 'OpenCode Buddy が入力を待っています',
	},
	ru: {
		taskCompleted: 'Задача завершена',
		taskFailed: 'Ошибка выполнения задачи',
		questionPending: 'OpenCode Buddy ожидает вашего ответа',
	},
	hi: {
		taskCompleted: 'कार्य पूर्ण',
		taskFailed: 'कार्य विफल',
		questionPending: 'OpenCode Buddy आपके उत्तर की प्रतीक्षा कर रहा है',
	},
	ko: {
		taskCompleted: '작업 완료',
		taskFailed: '작업 실패',
		questionPending: 'OpenCode Buddy가 입력을 기다리고 있습니다',
	},
	'pt-BR': {
		taskCompleted: 'Tarefa concluída',
		taskFailed: 'Falha na tarefa',
		questionPending: 'OpenCode Buddy está aguardando sua resposta',
	},
} as const;

export type CopyKey = keyof typeof COPY;

export function resolveCopyKey(userLanguage?: string | null, ideLanguage?: string): CopyKey {
	const stored = (userLanguage ?? '').trim();
	if (stored && stored in COPY) {
		return stored as CopyKey;
	}
	const ideLang = mapIdeLanguageToSupported(ideLanguage ?? '');
	if (ideLang in COPY) {
		return ideLang as CopyKey;
	}
	return 'en';
}
