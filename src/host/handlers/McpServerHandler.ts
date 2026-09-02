/**
 * McpServerHandler — opencode MCP 服务器的状态与配置管理。
 *
 * 职责分两半：
 *   查询类（走 daemon，反映运行时连接状态）
 *     get_mcp_server_status → `updateMcpServerStatus([{ name, status, error }])`
 *     get_mcp_server_tools  → `updateMcpServerTools({ serverId, tools, error })`
 *                             （opencode 不暴露 MCP 工具清单，回空 + 说明文案）
 *
 *   配置类（走 opencode 配置文件，反映持久化的增删改）
 *     get_mcp_servers → `updateMcpServers([...])`
 *     add_mcp_server / update_mcp_server / delete_mcp_server / toggle_mcp_server
 *
 *   导入类（只解析不落盘，落盘走前端确认后的 add_mcp_server）
 *     parse_copilot_mcp_config → `updateCopilotImportPreview({ servers, error? })`
 *
 * opencode 的 SDK 只有 `mcp.status/add/connect/disconnect`，CLI 只有
 * `mcp add/list/auth` —— 都没有 remove / update。所以真正的增删改只能落到
 * 配置文件（`~/.config/opencode/opencode.json` 的 `mcp` 段），由
 * `McpConfigService` 负责。
 *
 * **契约铁律**：每个消息无论成败都必须回调一次。前端多处都是
 * `setLoading(true)` 后等回调才 `setLoading(false)`，漏回一次就永久转圈
 * （市场、Copilot 导入、工具面板三个 loading bug 都是这么来的）。
 *
 * Frontend: 组件里 `get_${prefix}mcp_servers`（opencode 走空 prefix）。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { McpConfigService, type McpServerEntry } from '../services/McpConfigService';
import { parseCopilotConfig, type Language } from '../services/McpCopilotImportService';
import { logDiagnostic } from '../util/DiagnosticLogger';

const SUPPORTED_TYPES = [
	'get_mcp_servers',
	'get_mcp_server_status',
	'get_mcp_server_tools',
	'add_mcp_server',
	'update_mcp_server',
	'delete_mcp_server',
	'toggle_mcp_server',
	'parse_copilot_mcp_config',
];

interface McpStatusItem {
	name: string;
	status?: string;
	error?: string;
}

export class McpServerHandler extends BaseMessageHandler {
	private readonly configService = new McpConfigService();

	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_mcp_servers':
				this.handleGetServers();
				return true;
			case 'get_mcp_server_status':
				this.handleGetStatus();
				return true;
			case 'get_mcp_server_tools':
				this.handleGetTools(content);
				return true;
			case 'add_mcp_server':
			case 'update_mcp_server':
				this.handleUpsert(type, content);
				return true;
			case 'delete_mcp_server':
				this.handleDelete(content);
				return true;
			case 'toggle_mcp_server':
				this.handleToggle(content);
				return true;
			case 'parse_copilot_mcp_config':
				this.handleParseCopilotConfig(content);
				return true;
			default:
				return false;
		}
	}

	/**
	 * 配置文件是持久化状态的权威来源；只有在读取配置文件失败时才回退到
	 * daemon（后者只反映当前进程里已加载的 server）。
	 */
	private handleGetServers(): void {
		try {
			const servers = this.configService.listServers();
			logDiagnostic(`[MCP] get_mcp_servers from config count=${servers.length}`);
			this.callJavaScript('updateMcpServers', JSON.stringify(servers));
			return;
		} catch (err) {
			logDiagnostic(`[MCP] config read failed, falling back to daemon: ${String(err)}`);
		}
		this.requestMcp(
			'opencode.listMcpServers',
			(payload) => {
				const servers = payload && Array.isArray(payload.servers) ? payload.servers : [];
				this.callJavaScript('updateMcpServers', JSON.stringify(servers));
			},
			() => this.callJavaScript('updateMcpServers', JSON.stringify([])),
		);
	}

	private handleGetStatus(): void {
		this.requestMcp(
			'opencode.getMcpStatus',
			(payload) => {
				const raw = payload && Array.isArray(payload.statuses) ? payload.statuses : [];
				const statuses: McpStatusItem[] = raw.map((s) => {
					const item = s as Record<string, unknown>;
					const name = typeof item?.name === 'string' ? item.name : '';
					if (!name) {
						return null;
					}
					// SDK 状态 → webview McpServerStatusInfo 状态词汇。
					const status = mapMcpStatus(item.status);
					return {
						name,
						status,
						error: typeof item.error === 'string' ? item.error : undefined,
					} as McpStatusItem;
				}).filter((s): s is McpStatusItem => s !== null);
				this.callJavaScript('updateMcpServerStatus', JSON.stringify(statuses));
			},
			() => this.callJavaScript('updateMcpServerStatus', JSON.stringify([])),
		);
	}

	/**
	 * 工具列表：opencode 不暴露 per-server 工具查询，只能明确告知限制。
	 *
	 * 实测（2026-08）：MCP 服务器已 `connected` 时
	 *   GET /experimental/tool/ids                  → 仅 14 个内置工具
	 *   GET /experimental/tool?provider=..&model=.. → 仅 12 个内置工具
	 * 两者都不含 MCP server 注册的工具，SDK 也没有 per-server 端点。
	 * 按"能力复用 opencode"的原则不自建 MCP 客户端直连，因此回空 tools 并附
	 * 说明文案 —— 前端据此显示原因，而不是留一片空白让人以为服务器没配好。
	 *
	 * **必须回传 serverId**：`useToolsUpdate.ts:32` 有 `if (!serverId) return;`，
	 * 缺了它前端直接 return，loading 永不结束（工具面板一直转圈）。
	 */
	private handleGetTools(content: string): void {
		const serverId = parseStringField(content, 'serverId');
		if (!serverId) {
			logDiagnostic('[MCP] get_mcp_server_tools ignored: no serverId in payload');
			return;
		}
		this.callJavaScript('updateMcpServerTools', JSON.stringify({
			serverId,
			serverName: parseStringField(content, 'serverName') ?? serverId,
			tools: [],
			error: toolsUnavailableCopy(this.language()),
		}));
	}

	/**
	 * 解析 GitHub Copilot 的 MCP 配置为导入预览（只解析，不落盘）。
	 * 落盘由前端确认后逐个发 `add_mcp_server` 完成。
	 *
	 * **契约铁律**：无论成败都必须回调一次 `updateCopilotImportPreview`。
	 * 前端 `setLoading(true)` 后只有收到该回调才 `setLoading(false)`，
	 * 漏回一次弹窗就永久转圈（与市场 loading 同一个死法）。
	 */
	private handleParseCopilotConfig(content: string): void {
		const lang = this.language();
		const result = parseCopilotConfig(content, lang);
		if (result.error) {
			logDiagnostic(`[MCP] copilot import failed: ${result.error}`);
		} else {
			logDiagnostic(`[MCP] copilot import parsed servers=${result.servers.length}`);
		}
		this.callJavaScript('updateCopilotImportPreview', JSON.stringify(result));
	}

	/** 当前界面语言（zh / zh-TW / en）。 */
	private language(): Language {
		try {
			const stored = (this.context.getSettingsService().getUserLanguage() ?? '').trim();
			if (stored === 'zh' || stored === 'zh-TW') {
				return stored;
			}
		} catch {
			// 设置服务不可用时按英文兜底
		}
		return 'en';
	}

	private handleUpsert(type: string, content: string): void {
		const entry = parseServerEntry(content);
		if (!entry) {
			logDiagnostic(`[MCP] ${type} ignored: payload has no usable id`);
			return;
		}
		try {
			this.configService.upsertServer(entry);
			logDiagnostic(`[MCP] ${type} saved id=${entry.id} enabled=${entry.enabled ?? true}`);
		} catch (err) {
			logDiagnostic(`[MCP] ${type} failed id=${entry.id}: ${String(err)}`);
			return;
		}
		this.pushServerList();
	}

	private handleDelete(content: string): void {
		const id = parseId(content) ?? parseServerEntry(content)?.id;
		if (!id) {
			logDiagnostic('[MCP] delete_mcp_server ignored: no id in payload');
			return;
		}
		try {
			const removed = this.configService.deleteServer(id);
			logDiagnostic(`[MCP] delete_mcp_server id=${id} removed=${removed}`);
		} catch (err) {
			logDiagnostic(`[MCP] delete_mcp_server failed id=${id}: ${String(err)}`);
			return;
		}
		this.pushServerList();
	}

	private handleToggle(content: string): void {
		const entry = parseServerEntry(content);
		if (!entry) {
			logDiagnostic('[MCP] toggle_mcp_server ignored: no id in payload');
			return;
		}
		const enabled = entry.enabled !== false;
		try {
			this.configService.setEnabled(entry.id, enabled);
			logDiagnostic(`[MCP] toggle_mcp_server id=${entry.id} enabled=${enabled}`);
		} catch (err) {
			logDiagnostic(`[MCP] toggle_mcp_server failed id=${entry.id}: ${String(err)}`);
			return;
		}
		this.pushServerList();
	}

	/** 写操作后回推最新列表，让设置页立刻反映结果。 */
	private pushServerList(): void {
		try {
			this.callJavaScript('updateMcpServers', JSON.stringify(this.configService.listServers()));
		} catch (err) {
			logDiagnostic(`[MCP] push server list failed: ${String(err)}`);
		}
	}

	private requestMcp(
		method: string,
		onPayload: (payload: Record<string, unknown> | null) => void,
		onFail: () => void,
	): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			onFail();
			return;
		}
		const chunks: string[] = [];
		void daemon.request(method, {}, {
			onLine: (line) => chunks.push(line),
			onError: () => onFail(),
			onComplete: (success) => {
				if (!success) {
					onFail();
					return;
				}
				onPayload(this.extractJsonObject(chunks.join('\n')));
			},
		});
	}

	/** 从 daemon 输出缓冲区提取 JSON 对象（容错非 JSON 诊断行）。 */
	private extractJsonObject(raw: string): Record<string, unknown> | null {
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
				if (obj && (obj.servers !== undefined || obj.statuses !== undefined || obj.success !== undefined)) {
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
}

/** 解析前端下发的服务器对象；容忍 `id` 缺失时退回 `name`。 */
function parseServerEntry(content: string): McpServerEntry | null {
	if (!content || content.trim() === '') {
		return null;
	}
	let parsed: Record<string, unknown>;
	try {
		const value = JSON.parse(content) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return null;
		}
		parsed = value as Record<string, unknown>;
	} catch {
		return null;
	}
	const id = firstNonEmptyString(parsed.id, parsed.name);
	if (!id) {
		return null;
	}
	const spec = parsed.server && typeof parsed.server === 'object' && !Array.isArray(parsed.server)
		? parsed.server as McpServerEntry['server']
		: {};
	return {
		id,
		name: typeof parsed.name === 'string' ? parsed.name : id,
		server: spec,
		enabled: parsed.enabled !== false,
	};
}

function parseId(content: string): string | null {
	if (!content || content.trim() === '') {
		return null;
	}
	try {
		const value = JSON.parse(content) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return firstNonEmptyString((value as Record<string, unknown>).id);
		}
	} catch {
		// ignore
	}
	return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim() !== '') {
			return value.trim();
		}
	}
	return null;
}

// ── 文案 ────────────────────────────────────────────────────────────────

/**
 * 工具列表不可用时的说明文案。明说是 opencode 的平台限制而非故障，
 * 避免用户以为是自己没配好服务器。
 */
const TOOL_COPY: Record<Language, string> = {
	zh: 'opencode 暂未提供 MCP 工具查询接口，无法列出该服务器的工具（不影响工具的实际调用）',
	'zh-TW': 'opencode 暫未提供 MCP 工具查詢介面，無法列出該伺服器的工具（不影響工具的實際呼叫）',
	en: 'opencode does not expose an MCP tool listing API, so this server\'s tools cannot be shown (calls still work)',
};

function toolsUnavailableCopy(lang: Language): string {
	return TOOL_COPY[lang] ?? TOOL_COPY.en;
}

/** 读取消息载荷里的字符串字段（缺失或非字符串时返回 null）。 */
function parseStringField(content: string, field: string): string | null {
	if (!content || content.trim() === '') {
		return null;
	}
	try {
		const value = JSON.parse(content) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const raw = (value as Record<string, unknown>)[field];
			if (typeof raw === 'string' && raw.trim() !== '') {
				return raw.trim();
			}
		}
	} catch {
		// 载荷不是 JSON 时按缺失处理
	}
	return null;
}

/** SDK mcp.status 状态 → webview McpServerStatusInfo 词汇。 */
function mapMcpStatus(status: unknown): string {
	switch (status) {
		case 'connected':
			return 'connected';
		case 'disabled':
			return 'disabled';
		case 'needs_auth':
			return 'needs-auth';
		case 'failed':
			return 'failed';
		case 'needs_client_registration':
			return 'failed';
		default:
			return 'pending';
	}
}
