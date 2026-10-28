/**
 * SlashCommandCatalog — opencode 斜杠命令的单一数据源（SDK `command.list`）。
 *
 * 两个入口共用本模块，避免各写一份「请求 + 解析 + 容错」：
 *   - `commands.refresh`（v2 tab 命令，按目标 tab 的 cwd 列举）
 *   - 旧的窗口级刷新（`WindowEventHandler` 在 frontend_ready 等时机触发）
 *
 * 约定：列举失败一律回空列表，绝不展示可能不存在的硬编码「幽灵命令」。
 */
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';

export interface SlashCommandEntry {
	name: string;
	description?: string;
	source?: string;
}

/** 从 daemon 输出缓冲区提取 JSON 对象（容错非 JSON 诊断行）。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
	if (!raw || raw.trim() === '') {
		return null;
	}
	const lines = raw.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith('{') || !line.endsWith('}')) {
			continue;
		}
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (obj && (obj.commands !== undefined || obj.models !== undefined || obj.success !== undefined)) {
				return obj;
			}
		} catch {
			// 跳过
		}
	}
	try {
		const start = raw.lastIndexOf('{');
		const end = raw.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(raw.substring(start, end + 1)) as Record<string, unknown>;
		}
	} catch {
		// 忽略
	}
	return null;
}

/** 把 `command.list` 的原始 payload 归一化成 webview 期望的形状。 */
export function parseSlashCommands(payload: Record<string, unknown> | null): SlashCommandEntry[] {
	const raw = payload && Array.isArray(payload.commands) ? payload.commands : [];
	const commands: SlashCommandEntry[] = [];
	for (const c of raw) {
		const cmd = c as Record<string, unknown>;
		const rawName = typeof cmd?.name === 'string' ? cmd.name : '';
		const name = rawName.replace(/^\//, '');
		if (!name) {
			continue;
		}
		commands.push({
			name,
			description: typeof cmd.description === 'string' ? cmd.description : undefined,
			source:
				cmd.source === 'command' || cmd.source === 'mcp' || cmd.source === 'skill'
					? String(cmd.source)
					: undefined,
		});
	}
	return commands;
}

/**
 * 列举斜杠命令。
 *
 * @param daemon    常驻 daemon；缺失时直接回空列表
 * @param directory 目标 tab 的 cwd（`undefined` 表示沿用 serve 的默认目录）
 * @param onDone    必定被调用一次（成功或失败）
 */
export function listSlashCommands(
	daemon: OpenCodeDaemonBridge | null,
	directory: string | null,
	onDone: (commands: SlashCommandEntry[]) => void,
): void {
	if (!daemon) {
		onDone([]);
		return;
	}

	const chunks: string[] = [];
	void daemon.request('opencode.listCommands', directory ? { directory } : {}, {
		onLine: (line) => chunks.push(line),
		onError: () => onDone([]),
		onComplete: (success) => {
			if (!success) {
				onDone([]);
				return;
			}
			onDone(parseSlashCommands(extractJsonObject(chunks.join('\n'))));
		},
	});
}
