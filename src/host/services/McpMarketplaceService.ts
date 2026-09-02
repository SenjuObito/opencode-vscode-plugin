/**
 * McpMarketplaceService — MCP 市场（发现 + 归一化）。
 *
 * 逻辑从 cc-gui（JetBrains 版）的 `mcp/marketplace/*` 移植而来：
 * 发现与映射全部在宿主完成，webview 只负责展示与预览。
 *
 * 数据源：
 *   - `built-in`           内置预设（离线，始终可用）
 *   - `official-registry`  registry.modelcontextprotocol.io（MCP 官方）
 *
 * 曾内置 GitHub 官方镜像 `api.mcp.github.com`，但实测它单页就要 70 秒
 * （每条约 25KB，是官方 registry 的 33 倍），会拖垮整个弹窗，故移除。
 *
 * 任一源失败不影响其余源 —— 内置预设永远能出结果，避免弹窗卡在 loading。
 */
import { get as httpGet, type IncomingMessage } from 'http';
import { get as httpsGet } from 'https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

// ── 与 webview `types/mcp.ts` 对齐的数据结构（宿主不引用 webview 代码） ──

export interface McpMarketplaceSource {
	id: string;
	name: string;
	type: 'BUILT_IN' | 'REGISTRY' | 'GITHUB_ORG';
	url: string;
	enabled: boolean;
}

export interface McpInstallOption {
	label: string;
	type: 'stdio' | 'http' | 'sse';
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	source?: string;
	riskLevel?: string;
}

export interface McpMarketplaceEntry {
	id: string;
	name: string;
	displayName?: string;
	description?: string;
	status?: string;
	sourceId: string;
	sourceName: string;
	sourceType: string;
	homepage?: string;
	repositoryUrl?: string;
	docsUrl?: string;
	official: boolean;
	tags: string[];
	installOptions: McpInstallOption[];
}

export interface McpMarketplaceSearchResponse {
	query: string;
	sourceId: string;
	entries: McpMarketplaceEntry[];
	error?: string;
}

// ── 常量 ──

const MAX_RESULT_COUNT = 250;
const PAGE_LIMIT = 100;
/**
 * 只翻 3 页（约 300 条）。
 *
 * 实测（2026-08）：official registry 单页 100 条约 1.6s，翻满 20 页要 37s；
 * 而 GitHub registry 单页就要 70s（每条约 25KB，是 official 的 33 倍），
 * 因此该源已被移除。3 页在"够浏览"和"秒开"之间取平衡，配合磁盘缓存，
 * 二次打开基本无感。
 */
const MAX_PAGES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** 允许直接执行的包运行器；不在名单内的 runtimeHint 会被降级标记。 */
const KNOWN_RUNNERS = new Set([
	'npx', 'uvx', 'uv', 'pnpm', 'pnpx', 'bunx', 'node', 'deno', 'python', 'python3', 'docker', 'podman',
]);

/**
 * 会授予宿主访问权或提权的容器参数。registry 条目自定义 runtimeArguments 时会
 * 覆盖安全的默认前缀，出现这些 flag 就把风险等级降到 `unverified-command`，
 * 前端会显示醒目警告。
 */
const DANGEROUS_RUNNER_FLAGS = new Set([
	'--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns', '--network', '--net',
	'-v', '--volume', '--mount',
]);

interface CacheEntry {
	json: string;
	expiresAt: number;
}

// ── 服务 ──

export class McpMarketplaceService {
	private readonly sources: McpMarketplaceSource[] = [
		{ id: 'built-in', name: 'Built-in Presets', type: 'BUILT_IN', url: 'opencode-gui://built-in-mcp-presets', enabled: true },
		{ id: 'official-registry', name: 'Official MCP Registry', type: 'REGISTRY', url: 'https://registry.modelcontextprotocol.io', enabled: true },
	];

	private readonly cache = new Map<string, CacheEntry>();

	getSources(): McpMarketplaceSource[] {
		return this.sources;
	}

	async search(query: string, requestedSourceId: string, forceRefresh: boolean): Promise<McpMarketplaceEntry[]> {
		const all: McpMarketplaceEntry[] = [];

		for (const source of this.sources) {
			if (!source.enabled || !matchesRequestedSource(source, requestedSourceId)) {
				continue;
			}
			try {
				if (source.type === 'BUILT_IN') {
					// 离线预设只能本地过滤。
					all.push(...filterEntries(loadBuiltInEntries(source), query));
				} else if (source.type === 'REGISTRY') {
					// registry 支持服务端 search（实测 849ms/页），比拉全量再本地过滤
					// 快一个数量级且结果更相关，因此把 query 下推给它。
					all.push(...await this.loadRegistryEntries(source, forceRefresh, query));
				}
			} catch (err) {
				// 单个源失败不能拖垮整个搜索 —— 内置预设必须始终可用。
				// 这里不用 logDiagnostic：service 层保持零 vscode 依赖，便于独立测试。
				console.warn(`[MCP] marketplace source ${source.name} failed:`, err);
			}
		}

		const deduped = deduplicate(all);
		// 有查询词时按相关性排（名称命中优先于描述命中）；否则按
		// official → installable → 名称排，让稳定结果可预期。
		deduped.sort(query.trim() !== '' ? compareByRelevance(query) : compareEntries);
		return deduped.slice(0, MAX_RESULT_COUNT);
	}

	private async loadRegistryEntries(
		source: McpMarketplaceSource,
		forceRefresh: boolean,
		query: string,
	): Promise<McpMarketplaceEntry[]> {
		const byName = new Map<string, McpMarketplaceEntry>();
		let cursor: string | null = null;
		let page = 0;

		do {
			const url = buildPageUrl(source.url, cursor, query);
			const cacheKey = `${source.id}:${url}`;
			const json = await this.cachedGet(url, cacheKey, forceRefresh);
			const root = parseJsonSafe(json);
			if (!root) {
				break;
			}
			const servers = Array.isArray(root.servers) ? root.servers : [];
			for (const element of servers) {
				if (!element || typeof element !== 'object') {
					continue;
				}
				const entry = mapRegistryObject(element as Record<string, unknown>, source);
				if (entry && !byName.has(entry.name)) {
					byName.set(entry.name, entry);
				}
			}
			cursor = readNextCursor(root);
			page++;
		} while (cursor && page < MAX_PAGES);

		return [...byName.values()];
	}

	/**
	 * 两级缓存：进程内 Map → 磁盘（tmpdir，1h TTL）。
	 * 磁盘缓存让"重新加载窗口后再次打开市场"也能秒开，而不必重跑网络分页。
	 */
	private async cachedGet(url: string, cacheKey: string, forceRefresh: boolean): Promise<string> {
		const now = Date.now();
		if (!forceRefresh) {
			const hit = this.cache.get(cacheKey);
			if (hit && hit.expiresAt > now) {
				return hit.json;
			}
			const fromDisk = readDiskCache(cacheKey);
			if (fromDisk) {
				this.cache.set(cacheKey, { json: fromDisk, expiresAt: now + CACHE_TTL_MS });
				return fromDisk;
			}
		}
		const json = await httpGetText(url);
		this.cache.set(cacheKey, { json, expiresAt: now + CACHE_TTL_MS });
		writeDiskCache(cacheKey, json);
		return json;
	}
}

// ── 内置预设（离线源） ──

function loadBuiltInEntries(source: McpMarketplaceSource): McpMarketplaceEntry[] {
	/**
	 * 内置预设只保留在 npm 上实测可安装的包。
	 *
	 * cc-gui 原版带 5 个预设，但 2026-08 实测：
	 *   - `@modelcontextprotocol/server-time` 在 npm 上已 404（包被移除）
	 *   - `mcp-server-fetch` 只剩 `0.0.1-security` 这个废弃占位版本
	 * 用户装了必然连接失败，因此两者都移除。这里的每条都应定期用
	 * `npm view <pkg> version` 复核，避免再次给出装不上的预设。
	 */
	const presets: Array<{ id: string; displayName: string; description: string; pkg: string; docs: string; tags: string[] }> = [
		{
			id: 'memory',
			displayName: '@modelcontextprotocol/server-memory',
			description: 'Persist and query a local knowledge graph across chats.',
			pkg: '@modelcontextprotocol/server-memory',
			docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
			tags: ['stdio', 'memory', 'graph'],
		},
		{
			id: 'sequential-thinking',
			displayName: '@modelcontextprotocol/server-sequential-thinking',
			description: 'Expose a structured sequential-thinking tool for planning and reasoning.',
			pkg: '@modelcontextprotocol/server-sequential-thinking',
			docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
			tags: ['stdio', 'thinking', 'reasoning'],
		},
		{
			id: 'context7',
			displayName: '@upstash/context7-mcp',
			description: 'Retrieve current library documentation and code examples.',
			pkg: '@upstash/context7-mcp',
			docs: 'https://github.com/upstash/context7',
			tags: ['stdio', 'docs', 'search'],
		},
	];

	return presets.map((preset) => ({
		id: `${source.id}:${preset.id}`,
		name: preset.id,
		displayName: preset.displayName,
		description: preset.description,
		status: 'active',
		sourceId: source.id,
		sourceName: source.name,
		sourceType: source.type,
		homepage: preset.docs,
		repositoryUrl: preset.docs,
		docsUrl: preset.docs,
		official: true,
		tags: preset.tags,
		installOptions: [{
			label: 'NPX package',
			type: 'stdio' as const,
			command: 'npx',
			args: ['-y', preset.pkg],
			source: source.name,
			riskLevel: 'local-command',
		}],
	}));
}

// ── registry JSON → 市场条目 ──

function mapRegistryObject(envelope: Record<string, unknown>, source: McpMarketplaceSource): McpMarketplaceEntry | null {
	const data = asRecord(envelope.server) ?? envelope;
	const versionDetail = asRecord(data.version_detail);

	const name = firstString(
		firstStringFrom(data, 'name', 'id', 'server_name'),
		firstStringFrom(versionDetail, 'name', 'id', 'server_name'),
	);
	if (!name) {
		return null;
	}

	const displayName = firstString(
		firstStringFrom(data, 'title', 'display_name', 'displayName'),
		firstStringFrom(versionDetail, 'title', 'display_name', 'displayName'),
		shortName(name),
	);
	const description = firstString(
		firstStringFrom(data, 'description'),
		firstStringFrom(versionDetail, 'description'),
	);
	const version = firstString(
		firstStringFrom(data, 'version'),
		firstStringFrom(versionDetail, 'version'),
	);
	const status = firstString(firstStringFrom(data, 'status'), 'active');
	const repositoryUrl = firstString(
		readRepositoryUrl(data),
		readRepositoryUrl(versionDetail),
		firstStringFrom(data, 'websiteUrl'),
	);

	// official 徽章只信任官方 registry：_meta 是条目内嵌的，任何源都能伪造，
	// 因此非官方源即使带上该字段也不授予徽章。
	const official = isTrustedOfficialSource(source) && isOfficial(envelope);

	const tags: string[] = [source.name];
	if (version) {
		tags.push(version);
	}
	if (official) {
		tags.push('official');
	}

	return {
		id: `${source.id}:${name}`,
		name,
		displayName,
		description,
		status,
		sourceId: source.id,
		sourceName: source.name,
		sourceType: source.type,
		homepage: repositoryUrl,
		repositoryUrl,
		docsUrl: repositoryUrl,
		official,
		tags,
		installOptions: buildInstallOptions(data, versionDetail, name, source),
	};
}

function buildInstallOptions(
	data: Record<string, unknown> | null,
	versionDetail: Record<string, unknown> | null,
	serverName: string,
	source: McpMarketplaceSource,
): McpInstallOption[] {
	const options: McpInstallOption[] = [];
	if (!data) {
		return options;
	}

	const variables = [...parseVariables(data), ...parseVariables(versionDetail)];
	const headers = [...parseHeaders(data), ...parseHeaders(versionDetail)];

	options.push(...remoteOptions(data, variables, headers, source));
	options.push(...remoteOptions(versionDetail, variables, headers, source));
	options.push(...packageOptions(data, serverName, variables, source));
	options.push(...packageOptions(versionDetail, serverName, variables, source));

	return options;
}

function remoteOptions(
	object: Record<string, unknown> | null,
	baseVariables: VariableDefinition[],
	baseHeaders: HeaderDefinition[],
	source: McpMarketplaceSource,
): McpInstallOption[] {
	const remotes = asArray(object?.remotes);
	const options: McpInstallOption[] = [];
	for (const element of remotes) {
		const remote = asRecord(element);
		const url = firstStringFrom(remote, 'url');
		if (!url) {
			continue;
		}
		const transportType = firstString(
			firstStringFrom(remote, 'transport_type', 'transportType', 'type'),
			'http',
		) ?? 'http';
		const env = toEnvPlaceholders([...baseVariables, ...parseVariables(remote)]);
		const remoteHeaders = toHeaderPlaceholders([...baseHeaders, ...parseHeaders(remote)]);
		options.push({
			label: `${transportType.toUpperCase()} remote`,
			type: normalizeRemoteType(transportType),
			url,
			...(Object.keys(env).length > 0 ? { env } : {}),
			...(Object.keys(remoteHeaders).length > 0 ? { headers: remoteHeaders } : {}),
			source: source.name,
			riskLevel: 'remote',
		});
	}
	return options;
}

function packageOptions(
	object: Record<string, unknown> | null,
	serverName: string,
	baseVariables: VariableDefinition[],
	source: McpServerMarketSource,
): McpInstallOption[] {
	const packages = asArray(object?.packages);
	const options: McpInstallOption[] = [];
	for (const element of packages) {
		const pkg = asRecord(element);
		const option = createPackageOption(pkg, serverName, baseVariables, source);
		if (option) {
			options.push(option);
		}
	}
	return options;
}

type McpServerMarketSource = McpMarketplaceSource;

function createPackageOption(
	pkg: Record<string, unknown> | null,
	serverName: string,
	baseVariables: VariableDefinition[],
	source: McpMarketplaceSource,
): McpInstallOption | null {
	if (!pkg) {
		return null;
	}
	const name = firstString(firstStringFrom(pkg, 'name', 'identifier'), serverName);
	if (!name) {
		return null;
	}
	const version = firstStringFrom(pkg, 'version');
	const registryType = normalizeRegistryType(firstStringFrom(pkg, 'registry_type', 'registryType', 'type'));
	const hint = firstString(firstStringFrom(pkg, 'runtimeHint', 'runtime_hint'));

	const env: Record<string, string> = {
		...toEnvPlaceholders(baseVariables),
		...renderEnvironmentVariables(asArray(pkg.environmentVariables ?? pkg.environment_variables)),
	};

	const runtimeArgs = renderArguments(asArray(pkg.runtimeArguments ?? pkg.runtime_arguments));
	const packageArgs = renderArguments(asArray(pkg.packageArguments ?? pkg.package_arguments));
	const transport = normalizePackageTransport(firstStringFrom(asRecord(pkg.transport), 'type'));

	const args: string[] = [];
	let command: string;
	let label: string;
	let riskLevel: string;

	if (registryType === 'docker') {
		// 已知类型下，非白名单 runtimeHint 一律忽略，改用规范运行器，
		// 防止 registry 条目把命令换成任意内容。
		command = isKnownRunner(hint) ? hint : 'docker';
		args.push(...(runtimeArgs.length > 0 ? runtimeArgs : ['run', '-i', '--rm']));
		args.push(name);
		args.push(...packageArgs);
		label = 'Docker image';
		riskLevel = 'container-command';
	} else if (registryType === 'npm') {
		command = isKnownRunner(hint) ? hint : 'npx';
		args.push(...(runtimeArgs.length > 0 ? runtimeArgs : ['-y']));
		args.push(installName(name, version));
		args.push(...packageArgs);
		label = 'NPX package';
		riskLevel = 'local-command';
	} else if (registryType === 'pypi') {
		command = isKnownRunner(hint) ? hint : 'uvx';
		args.push(...runtimeArgs);
		args.push(installName(name, version));
		args.push(...packageArgs);
		label = 'UVX package';
		riskLevel = 'local-command';
	} else if (hint) {
		// 未知类型没有规范运行器可兜底，沿用 registry 给的命令并做风险标记。
		command = hint;
		args.push(...runtimeArgs);
		args.push(installName(name, version));
		args.push(...packageArgs);
		label = `${command} package`;
		riskLevel = isKnownRunner(hint) ? 'local-command' : 'unverified-command';
	} else {
		return null;
	}

	// 条目自带的 runtimeArguments 会覆盖安全前缀，含提权 flag 时降级告警。
	if (hasDangerousRunnerArg(runtimeArgs)) {
		riskLevel = 'unverified-command';
	}

	return {
		label,
		type: transport,
		command,
		args,
		...(Object.keys(env).length > 0 ? { env } : {}),
		source: source.name,
		riskLevel,
	};
}

// ── 排序 / 去重 / 过滤 ──

function compareEntries(left: McpMarketplaceEntry, right: McpMarketplaceEntry): number {
	const official = Number(right.official) - Number(left.official);
	if (official !== 0) {
		return official;
	}
	const installable = Number(right.installOptions.length > 0) - Number(left.installOptions.length > 0);
	if (installable !== 0) {
		return installable;
	}
	return safe(left.displayName ?? left.name).localeCompare(safe(right.displayName ?? right.name), undefined, {
		sensitivity: 'base',
	});
}

/**
 * 相关性排序。registry 的服务端 search 只管匹配、不管排序，原样返回会退化成
 * 字母序（搜 "github" 首位是 "0nMCP"）。这里按"名称命中 > id 命中 > 描述命中"
 * 打分，同分时再退回稳定的 {@link compareEntries}。
 */
function compareByRelevance(query: string) {
	const terms = query.trim().toLowerCase().split(/\s+/);
	return (left: McpMarketplaceEntry, right: McpMarketplaceEntry): number => {
		const diff = scoreRelevance(right, terms) - scoreRelevance(left, terms);
		return diff !== 0 ? diff : compareEntries(left, right);
	};
}

function scoreRelevance(entry: McpMarketplaceEntry, terms: string[]): number {
	const display = safe(entry.displayName).toLowerCase();
	const id = safe(entry.name).toLowerCase();
	const description = safe(entry.description).toLowerCase();
	let total = 0;
	for (const term of terms) {
		if (display === term || id === term) {
			total += 100;
		} else if (display.startsWith(term)) {
			total += 60;
		} else if (id.startsWith(term)) {
			total += 40;
		} else if (display.includes(term)) {
			total += 20;
		} else if (id.includes(term)) {
			total += 10;
		} else if (description.includes(term)) {
			total += 5;
		} else {
			// 服务端判定相关但本地看不出命中位置（例如命中了仓库 URL），
			// 给一个非零基础分，保证它排在完全无关的条目之前。
			total += 1;
		}
	}
	return total;
}

function deduplicate(entries: McpMarketplaceEntry[]): McpMarketplaceEntry[] {
	const map = new Map<string, McpMarketplaceEntry>();
	for (const entry of entries) {
		const key = `${safe(entry.sourceId)}:${safe(entry.name)}`;
		if (!map.has(key)) {
			map.set(key, entry);
		}
	}
	return [...map.values()];
}

function filterEntries(entries: McpMarketplaceEntry[], query: string): McpMarketplaceEntry[] {
	const trimmed = query.trim().toLowerCase();
	if (trimmed === '') {
		return entries;
	}
	const terms = trimmed.split(/\s+/);
	return entries.filter((entry) => {
		const searchable = [
			entry.name,
			entry.displayName,
			entry.description,
			entry.repositoryUrl,
			...entry.tags,
		].map(safe).join(' ').toLowerCase();
		return terms.every((term) => searchable.includes(term));
	});
}

function matchesRequestedSource(source: McpMarketplaceSource, requestedSourceId: string): boolean {
	return !requestedSourceId || requestedSourceId === 'all' || source.id === requestedSourceId;
}

// ── 小工具 ──

function buildPageUrl(baseUrl: string, cursor: string | null, query: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	let url = `${base}/v0.1/servers?limit=${PAGE_LIMIT}`;
	const trimmedQuery = query.trim();
	if (trimmedQuery !== '') {
		url += `&search=${encodeURIComponent(trimmedQuery)}`;
	}
	return cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
}

function readNextCursor(root: Record<string, unknown>): string | null {
	const metadata = asRecord(root.metadata);
	const cursor = firstString(firstStringFrom(metadata, 'next_cursor'), firstStringFrom(metadata, 'nextCursor'));
	return cursor && cursor.trim() !== '' ? cursor : null;
}

function isKnownRunner(runner: string | undefined): runner is string {
	return !!runner && KNOWN_RUNNERS.has(runner.trim().toLowerCase());
}

function hasDangerousRunnerArg(runtimeArgs: string[]): boolean {
	return runtimeArgs.some((arg) => {
		const normalized = arg.trim().toLowerCase();
		const eq = normalized.indexOf('=');
		const flag = eq >= 0 ? normalized.slice(0, eq) : normalized;
		return DANGEROUS_RUNNER_FLAGS.has(flag);
	});
}

/** 命名参数展开成 `[name, value]`，位置参数只放 value；缺失值用 `{valueHint}` 占位。 */
function renderArguments(argumentsArray: unknown[]): string[] {
	const result: string[] = [];
	for (const element of argumentsArray) {
		const arg = asRecord(element);
		if (!arg) {
			continue;
		}
		const type = firstString(firstStringFrom(arg, 'type'), 'positional');
		let value = firstString(firstStringFrom(arg, 'value'), firstStringFrom(arg, 'default', 'defaultValue'));
		if (!value) {
			const hint = firstString(firstStringFrom(arg, 'valueHint', 'value_hint'));
			if (hint) {
				value = `{${hint}}`;
			}
		}
		if (type?.toLowerCase() === 'named') {
			const name = firstStringFrom(arg, 'name');
			if (!name) {
				continue;
			}
			result.push(name);
			if (value) {
				result.push(value);
			}
		} else if (value) {
			result.push(value);
		}
	}
	return result;
}

function renderEnvironmentVariables(environmentVariables: unknown[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const element of environmentVariables) {
		const env = asRecord(element);
		const name = firstStringFrom(env, 'name');
		if (!name) {
			continue;
		}
		const value = firstString(
			firstStringFrom(env, 'value'),
			firstStringFrom(env, 'default', 'defaultValue'),
			`{${name.toLowerCase()}}`,
		);
		values[name] = value ?? `{${name.toLowerCase()}}`;
	}
	return values;
}

interface VariableDefinition {
	name: string;
	defaultValue?: string;
}

interface HeaderDefinition {
	name: string;
}

function parseVariables(object: Record<string, unknown> | null): VariableDefinition[] {
	return asArray(object?.variables)
		.map((element): VariableDefinition | null => {
			const variable = asRecord(element);
			const name = firstStringFrom(variable, 'name');
			return name ? { name, defaultValue: firstStringFrom(variable, 'default', 'defaultValue') } : null;
		})
		.filter((v): v is VariableDefinition => v !== null);
}

function parseHeaders(object: Record<string, unknown> | null): HeaderDefinition[] {
	return asArray(object?.headers)
		.map((element) => {
			const header = asRecord(element);
			const name = firstStringFrom(header, 'name');
			return name ? { name } : null;
		})
		.filter((h): h is HeaderDefinition => h !== null);
}

function toEnvPlaceholders(variables: VariableDefinition[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const variable of variables) {
		if (!variable.name) {
			continue;
		}
		values[variable.name] = variable.defaultValue ?? `{${variable.name.toLowerCase()}}`;
	}
	return values;
}

function toHeaderPlaceholders(headers: HeaderDefinition[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const header of headers) {
		if (!header.name) {
			continue;
		}
		values[header.name] = `{${header.name.toLowerCase().replace(/-/g, '_')}}`;
	}
	return values;
}

function isTrustedOfficialSource(source: McpMarketplaceSource): boolean {
	try {
		return new URL(source.url).hostname.toLowerCase() === 'registry.modelcontextprotocol.io';
	} catch {
		return false;
	}
}

function isOfficial(envelope: Record<string, unknown>): boolean {
	const meta = asRecord(envelope._meta);
	const official = asRecord(meta?.['io.modelcontextprotocol.registry/official']);
	if (!official) {
		return false;
	}
	// 要求有结构化元数据，而不是仅有这个 key —— 否则恶意条目可以伪造徽章。
	return 'id' in official || 'publishedAt' in official || 'isLatest' in official;
}

function readRepositoryUrl(object: Record<string, unknown> | null): string | undefined {
	const repository = asRecord(object?.repository);
	return firstStringFrom(repository, 'url');
}

function normalizeRegistryType(registryType: string | undefined): string {
	const normalized = (registryType ?? '').trim().toLowerCase();
	if (normalized.includes('npm')) {
		return 'npm';
	}
	if (normalized.includes('pypi') || normalized.includes('python') || normalized.includes('uv')) {
		return 'pypi';
	}
	if (normalized.includes('docker') || normalized.includes('oci')) {
		return 'docker';
	}
	return normalized;
}

function normalizePackageTransport(type: string | undefined): 'stdio' | 'http' | 'sse' {
	const lower = (type ?? '').toLowerCase();
	if (lower.includes('sse')) {
		return 'sse';
	}
	if (lower.includes('http')) {
		return 'http';
	}
	return 'stdio';
}

function normalizeRemoteType(transportType: string | undefined): 'stdio' | 'http' | 'sse' {
	return (transportType ?? '').toLowerCase().includes('sse') ? 'sse' : 'http';
}

/** 只有版本号且包名未自带 `@版本` 时才拼接（`@scope/pkg` 的首个 @ 不是版本分隔符）。 */
function installName(name: string, version: string | undefined): string {
	if (!version || name.lastIndexOf('@') > 0) {
		return name;
	}
	return `${name}@${version}`;
}

function shortName(name: string): string {
	const slash = name.lastIndexOf('/');
	return slash >= 0 ? name.slice(slash + 1) : name;
}

function safe(value: string | undefined): string {
	return value ?? '';
}

function firstString(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value && value.trim() !== '') {
			return value;
		}
	}
	return undefined;
}

function firstStringFrom(object: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
	if (!object) {
		return undefined;
	}
	for (const key of keys) {
		const value = object[key];
		if (typeof value === 'string' && value.trim() !== '') {
			return value;
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return !!value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

/** 磁盘缓存目录：放在 tmpdir，随系统清理，不污染用户配置。 */
function cacheDir(): string {
	return join(tmpdir(), 'opencode-gui-mcp-marketplace');
}

function cacheFilePath(cacheKey: string): string {
	return join(cacheDir(), `${createHash('sha1').update(cacheKey).digest('hex')}.json`);
}

function readDiskCache(cacheKey: string): string | null {
	try {
		const file = cacheFilePath(cacheKey);
		if (!existsSync(file)) {
			return null;
		}
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as { expiresAt?: number; json?: string };
		if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() || typeof parsed.json !== 'string') {
			return null;
		}
		return parsed.json;
	} catch {
		return null;
	}
}

function writeDiskCache(cacheKey: string, json: string): void {
	try {
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(cacheFilePath(cacheKey), JSON.stringify({
			expiresAt: Date.now() + CACHE_TTL_MS,
			json,
		}), 'utf8');
	} catch {
		// 缓存写失败不影响功能
	}
}

/** GET 文本，带超时、体积上限与有限次重定向跟随。 */
function httpGetText(url: string, redirectsLeft = 3): Promise<string> {
	return new Promise((resolve, reject) => {
		const isHttps = url.startsWith('https:');
		const transport = isHttps ? httpsGet : httpGet;
		const request = transport(url, {
			headers: { Accept: 'application/json', 'User-Agent': 'opencode-gui-vscode' },
		}, (response: IncomingMessage) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
				response.resume();
				const next = new URL(response.headers.location, url).toString();
				httpGetText(next, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject(new Error(`HTTP ${status}`));
				return;
			}
			let size = 0;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_RESPONSE_BYTES) {
					request.destroy(new Error('registry response too large'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			response.on('error', reject);
		});
		request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('registry request timed out')));
		request.on('error', reject);
	});
}
