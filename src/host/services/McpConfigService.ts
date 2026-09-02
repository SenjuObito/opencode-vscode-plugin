/**
 * McpConfigService — opencode MCP server 配置的真实读写层。
 *
 * opencode 把 MCP 服务器放在配置文件里（`~/.config/opencode/opencode.json`
 * 的 `mcp` 段），SDK 只暴露 `status/add/connect/disconnect`，**没有**
 * remove / update 接口；CLI 也只有 `mcp add/list/auth`，同样没有 remove。
 * 所以要让设置页的增 / 删 / 改 / 启用禁用真正生效，只能落到这里。
 *
 * opencode 的配置形状（见 SDK types.gen.d.ts `McpLocalConfig` /
 * `McpRemoteConfig` / `Config.mcp`）：
 *
 * ```json
 * {
 *   "mcp": {
 *     "local-name": {
 *       "type": "local",
 *       "command": ["npx", "-y", "some-package"],
 *       "environment": { "TOKEN": "..." },
 *       "enabled": true
 *     },
 *     "remote-name": {
 *       "type": "remote",
 *       "url": "https://example.com/mcp",
 *       "headers": { "Authorization": "Bearer ..." },
 *       "enabled": true
 *     },
 *     "only-disabled-here": { "enabled": false }
 *   }
 * }
 * ```
 *
 * 注意第三项：`mcp` 的值允许只有 `enabled`（在别处定义了 server，此处仅
 * 覆盖开关）。读取时必须保留这种条目，否则用户的禁用状态会被误清。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/** webview 侧 `McpServerSpec` 的宿主等价物（字段宽松，来自不受信的前端）。 */
export interface McpServerSpec {
	type?: string;
	command?: string | string[];
	args?: string[];
	env?: Record<string, string>;
	environment?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	timeout?: number;
	[key: string]: unknown;
}

/** 宿主 ↔ webview 交换用的服务器条目。 */
export interface McpServerEntry {
	id: string;
	name?: string;
	server: McpServerSpec;
	enabled?: boolean;
	[key: string]: unknown;
}

/** opencode 配置文件里 `mcp` 段的一个值。 */
type OpencodeMcpEntry = Record<string, unknown>;

interface OpencodeConfigFile {
	mcp?: Record<string, OpencodeMcpEntry>;
	[key: string]: unknown;
}

/** 写入前保留多少份滚动备份。 */
const MAX_BACKUPS = 5;

export class McpConfigService {
	/** 配置文件路径（遵循 XDG：优先 $XDG_CONFIG_HOME，其次 ~/.config）。 */
	static resolveConfigPath(): string {
		const xdg = (process.env.XDG_CONFIG_HOME ?? '').trim();
		const base = xdg !== '' ? xdg : join(homedir(), '.config');
		return join(base, 'opencode', 'opencode.json');
	}

	/** 读取整个配置；文件缺失或格式异常时返回空对象（不抛错）。 */
	readConfig(): OpencodeConfigFile {
		const path = McpConfigService.resolveConfigPath();
		if (!existsSync(path)) {
			return {};
		}
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as OpencodeConfigFile;
			}
		} catch {
			// 损坏的配置文件按空处理，避免整个设置页打不开
		}
		return {};
	}

	/** 原子写：先写临时文件再 rename，并在写前滚动备份一份。 */
	writeConfig(config: OpencodeConfigFile): void {
		const path = McpConfigService.resolveConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path)) {
			this.rotateBackup(path);
		}
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
		renameSync(temp, path);
	}

	/** 返回配置里的全部 MCP 服务器（含仅 `{ enabled }` 的覆盖项）。 */
	listServers(): McpServerEntry[] {
		const config = this.readConfig();
		const mcp = config.mcp;
		if (!mcp || typeof mcp !== 'object') {
			return [];
		}
		return Object.keys(mcp).map((id) => {
			const raw = mcp[id] ?? {};
			return {
				id,
				name: id,
				server: fromOpencodeSpec(raw),
				enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
			};
		});
	}

	/** 新增或整体替换一个服务器（id 冲突时覆盖）。 */
	upsertServer(entry: McpServerEntry): void {
		const config = this.readConfig();
		if (!config.mcp || typeof config.mcp !== 'object') {
			config.mcp = {};
		}
		const spec = toOpencodeSpec(entry.server);
		if (typeof entry.enabled === 'boolean') {
			spec.enabled = entry.enabled;
		}
		config.mcp[entry.id] = spec;
		this.writeConfig(config);
	}

	/** 删除一个服务器；不存在时返回 false。 */
	deleteServer(id: string): boolean {
		const config = this.readConfig();
		if (!config.mcp || typeof config.mcp !== 'object' || !(id in config.mcp)) {
			return false;
		}
		delete config.mcp[id];
		this.writeConfig(config);
		return true;
	}

	/**
	 * 只改开关。若条目已存在则就地改 `enabled`；若不存在（服务器定义在
	 * 项目级配置里）则写入一个仅有 `enabled` 的覆盖项 —— 这正是 opencode
	 * 配置模型允许的写法。
	 */
	setEnabled(id: string, enabled: boolean): boolean {
		const config = this.readConfig();
		if (!config.mcp || typeof config.mcp !== 'object') {
			config.mcp = {};
		}
		const existing = config.mcp[id];
		if (existing && typeof existing === 'object') {
			existing.enabled = enabled;
		} else {
			config.mcp[id] = { enabled };
		}
		this.writeConfig(config);
		return true;
	}

	/** 滚动备份：opencode.json.bak.1 ~ .bak.N（1 为最新）。 */
	private rotateBackup(path: string): void {
		try {
			for (let i = MAX_BACKUPS; i > 1; i--) {
				const from = `${path}.bak.${i - 1}`;
				const to = `${path}.bak.${i}`;
				if (existsSync(from)) {
					copyFileSync(from, to);
				}
			}
			copyFileSync(path, `${path}.bak.1`);
		} catch {
			// 备份失败不应阻断主流程
		}
	}
}

/** opencode 配置 → webview spec（`command: string[]` 拆成 command + args）。 */
function fromOpencodeSpec(raw: OpencodeMcpEntry): McpServerSpec {
	const spec: McpServerSpec = {};
	const type = typeof raw.type === 'string' ? raw.type : undefined;

	if (Array.isArray(raw.command)) {
		const parts = raw.command.filter((p): p is string => typeof p === 'string');
		spec.type = type ?? 'local';
		spec.command = parts[0] ?? '';
		spec.args = parts.slice(1);
	} else if (typeof raw.url === 'string') {
		spec.type = type ?? 'remote';
		spec.url = raw.url;
	} else {
		spec.type = type ?? 'local';
	}

	if (raw.environment && typeof raw.environment === 'object') {
		spec.environment = raw.environment as Record<string, string>;
	}
	if (raw.headers && typeof raw.headers === 'object') {
		spec.headers = raw.headers as Record<string, string>;
	}
	if (typeof raw.cwd === 'string') {
		spec.cwd = raw.cwd;
	}
	if (typeof raw.timeout === 'number') {
		spec.timeout = raw.timeout;
	}
	return spec;
}

/** webview spec → opencode 配置；丢弃 opencode 不认识的字段。 */
function toOpencodeSpec(spec: McpServerSpec): OpencodeMcpEntry {
	const entry: OpencodeMcpEntry = {};
	const rawType = typeof spec.type === 'string' ? spec.type.toLowerCase() : '';
	const isRemote = rawType === 'remote' || rawType === 'http' || rawType === 'sse'
		|| (rawType === '' && typeof spec.url === 'string' && spec.url !== '');

	if (isRemote) {
		entry.type = 'remote';
		if (typeof spec.url === 'string') {
			entry.url = spec.url;
		}
		if (isNonEmptyObject(spec.headers)) {
			entry.headers = spec.headers;
		}
	} else {
		entry.type = 'local';
		const command = normalizeCommand(spec.command, spec.args);
		if (command.length > 0) {
			entry.command = command;
		}
		const environment = isNonEmptyObject(spec.environment) ? spec.environment : spec.env;
		if (isNonEmptyObject(environment)) {
			entry.environment = environment;
		}
		if (typeof spec.cwd === 'string' && spec.cwd.trim() !== '') {
			entry.cwd = spec.cwd;
		}
	}

	if (typeof spec.timeout === 'number' && Number.isFinite(spec.timeout)) {
		entry.timeout = spec.timeout;
	}
	return entry;
}

/** `command` 可能是字符串或数组，`args` 可选 —— 统一成 opencode 要的数组。 */
function normalizeCommand(command: unknown, args: unknown): string[] {
	const head: string[] = [];
	if (typeof command === 'string') {
		const trimmed = command.trim();
		if (trimmed !== '') {
			head.push(...splitCommandLine(trimmed));
		}
	} else if (Array.isArray(command)) {
		head.push(...command.filter((p): p is string => typeof p === 'string' && p.trim() !== ''));
	}
	if (Array.isArray(args)) {
		head.push(...args.filter((p): p is string => typeof p === 'string'));
	}
	return head;
}

/** 极简 shell 词法切分：支持引号包裹，够用即可（命令行来自用户输入）。 */
function splitCommandLine(input: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== '') {
				parts.push(current);
				current = '';
			}
			continue;
		}
		current += char;
	}
	if (current !== '') {
		parts.push(current);
	}
	return parts;
}

function isNonEmptyObject(value: unknown): value is Record<string, string> {
	return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}
