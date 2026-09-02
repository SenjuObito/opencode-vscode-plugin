/**
 * McpCopilotImportService — 把 GitHub Copilot / Claude 的 MCP 配置解析成内部条目。
 *
 * 只做**解析与字段映射，不落盘**：落盘由前端确认后逐个发 `add_mcp_server`，
 * 经 `McpConfigService` 转成 opencode 配置。与 cc-gui 的
 * `mcp/importer/McpServerImportService` 职责一致，但面向 opencode 的类型体系
 * （Copilot 的 stdio/sse/http 三种 → opencode 只有 local/remote）。
 *
 * 本模块是纯逻辑、零 vscode 依赖，可单独 bundle 后用 node 验证（见 README 的
 * "宿主纯逻辑 service 的独立验证手法"）。
 */

export type Language = 'zh' | 'zh-TW' | 'en';

interface CopilotCopy {
	invalidJson: string;
	noServers: string;
	emptyInput: string;
}

const COPILOT_COPY: Record<Language, CopilotCopy> = {
	zh: {
		invalidJson: 'JSON 解析失败，请检查粘贴的内容',
		noServers: '未找到 servers 字段，请确认粘贴的是 GitHub Copilot 的 MCP 配置',
		emptyInput: '请先粘贴配置内容',
	},
	'zh-TW': {
		invalidJson: 'JSON 解析失敗，請檢查貼上的內容',
		noServers: '未找到 servers 欄位，請確認貼上的是 GitHub Copilot 的 MCP 設定',
		emptyInput: '請先貼上設定內容',
	},
	en: {
		invalidJson: 'Failed to parse JSON, please check the pasted content',
		noServers: 'No "servers" field found — please paste a GitHub Copilot MCP configuration',
		emptyInput: 'Please paste the configuration first',
	},
};

/** 解析结果：`error` 非空时 `servers` 一定为空数组。 */
export interface CopilotParseResult {
	servers: McpServerEntry[];
	error?: string;
}

/** 与 webview `McpServer` 对应的宿主侧条目（字段宽松，来自不受信输入）。 */
export interface McpServerEntry {
	id: string;
	name?: string;
	server: Record<string, unknown>;
	enabled?: boolean;
	[key: string]: unknown;
}

/**
 * 解析配置文本。
 *
 * @param content 宿主消息载荷 —— 既接受 `{ json: "<配置文本>" }` 信封，
 *                也接受直接就是配置文本的裸字符串。
 * @param lang    界面语言，决定错误文案
 */
export function parseCopilotConfig(content: string, lang: Language): CopilotParseResult {
	const copy = COPILOT_COPY[lang] ?? COPILOT_COPY.en;

	if (!content || content.trim() === '') {
		return { servers: [], error: copy.emptyInput };
	}

	let raw = content;
	try {
		const envelope = JSON.parse(content) as unknown;
		if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
			const inner = (envelope as Record<string, unknown>).json;
			if (typeof inner === 'string') {
				raw = inner;
			}
		}
	} catch {
		return { servers: [], error: copy.invalidJson };
	}

	if (raw.trim() === '') {
		return { servers: [], error: copy.emptyInput };
	}

	let config: Record<string, unknown>;
	try {
		const value = JSON.parse(raw) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { servers: [], error: copy.invalidJson };
		}
		config = value as Record<string, unknown>;
	} catch {
		return { servers: [], error: copy.invalidJson };
	}

	// Copilot 用 `servers`，Claude 用 `mcpServers` —— 两者都接受。
	const servers = asObject(config.servers) ?? asObject(config.mcpServers);
	if (!servers) {
		return { servers: [], error: copy.noServers };
	}

	const entries: McpServerEntry[] = [];
	for (const [id, value] of Object.entries(servers)) {
		const entry = mapCopilotServer(id, value);
		if (entry) {
			entries.push(entry);
		}
	}
	if (entries.length === 0) {
		return { servers: [], error: copy.noServers };
	}
	return { servers: entries };
}

/**
 * 单条配置 → 内部条目。
 *
 * 类型收敛：Copilot 的 `stdio` 归 opencode 的 `local`，`sse`/`http` 归 `remote`。
 * 缺失 `type` 时按 command/url 推断（与 cc-gui 的 McpServerImportService 一致）。
 * id 直接用键名，重命名交给前端（`McpImportDialog` 的 `uniqueId` 处理冲突）。
 */
export function mapCopilotServer(id: string, value: unknown): McpServerEntry | null {
	if (id.trim() === '') {
		return null;
	}
	const source = asObject(value);
	if (!source) {
		return null;
	}

	const spec: Record<string, unknown> = {};
	const declaredType = typeof source.type === 'string' ? source.type.toLowerCase() : '';
	const command = typeof source.command === 'string' && source.command.trim() !== ''
		? source.command
		: undefined;
	const url = typeof source.url === 'string' && source.url.trim() !== '' ? source.url : undefined;

	if (declaredType === 'stdio' || (declaredType === '' && !!command)) {
		spec.type = 'local';
	} else {
		spec.type = 'remote';
	}

	if (command) {
		spec.command = command;
	}
	const args = asStringArray(source.args);
	if (args.length > 0) {
		spec.args = args;
	}
	if (url) {
		spec.url = url;
	}
	const env = asObject(source.env);
	if (env) {
		spec.env = env;
	}
	const headers = mergeHeaders(source);
	if (Object.keys(headers).length > 0) {
		spec.headers = headers;
	}
	if (typeof source.cwd === 'string' && source.cwd.trim() !== '') {
		spec.cwd = source.cwd;
	}

	return { id, name: id, server: spec, enabled: true };
}

/**
 * 合并请求头：`requestInit.headers` 打底，`headers` 覆盖（后者优先）。
 * 丢弃 null / 非标量值，避免把无效头写进 opencode 配置。
 */
export function mergeHeaders(source: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	const collect = (value: unknown): void => {
		const map = asObject(value);
		if (!map) {
			return;
		}
		for (const [key, item] of Object.entries(map)) {
			if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
				result[key] = String(item);
			}
		}
	};
	const requestInit = asObject(source.requestInit);
	if (requestInit) {
		collect(requestInit.headers);
	}
	collect(source.headers);
	return result;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return !!value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
