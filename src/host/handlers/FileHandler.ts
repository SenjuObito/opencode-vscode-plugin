/**
 * FileHandler — port of cc-gui `handler/file/FileHandler.java` (opencode subset).
 * open_file / resolve_file_path / get_linkify_capabilities / list_files。
 * 文件打开经宿主注入的 FileOps（VS Code showTextDocument）。
 *
 * list_files：@ 文件补全候选。**唯一来源是 opencode API**：
 *  - 空 query（刚输入 `@`）或 `@dir/` → daemon `opencode.listFiles`
 *    （服务端 `GET /api/fs/list`，一次一层，目录导航）；
 *  - 有搜索文本 → daemon `opencode.findFiles`（服务端 `GET /api/fs/find`，
 *    frecency + 模糊已排序），query 拼上 `currentPath` 前缀实现目录作用域。
 * 二者都按**目标 tab 的 cwd** 请求（core 用 `x-opencode-directory` 固定作用域）。
 *
 * 插件定位是 opencode 的 GUI：候选能力全部来自 opencode 服务。历史上那套
 * 本地采集（打开的编辑器 + workspace.findFiles + 浅层目录扫描）保留在
 * `collectEntries` 里仅作对照/应急，由 `LOCAL_FILE_COLLECTORS_ENABLED` 关闭，
 * 产品路径不再调用。
 *
 * 结果经 tab 事件 `files.listed` 回推 `{files:[{name,path,absolutePath,type,extension}], requestId}`。
 * 必须始终回包（失败也回空列表），否则前端会挂到超时才清 loading。
 */
import * as vscode from 'vscode';
import { promises as fsp } from 'fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'path';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['open_file', 'resolve_file_path', 'get_linkify_capabilities', 'list_files'];

/** 目录浅扫参数与排除集（与前端 shouldHideFile / 常见构建产物对齐）。 */
const DIR_SCAN_MAX_DEPTH = 3;
const DIR_SCAN_MAX_ENTRIES = 3000;
const RESULT_LIMIT = 50;
const FIND_FILES_LIMIT_PER_ROOT = 2000;
const EXCLUDED_DIR_NAMES = new Set([
	'node_modules', '.git', '.idea', '.vscode', '.vs', 'dist', 'out',
	'build', 'target', '.next', '.nuxt', 'coverage', '__pycache__',
]);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * 自研文件采集器开关。
 *
 * 插件是 opencode 的 GUI 外壳，@ 候选必须由 opencode API 提供，因此本文件
 * 里的本地采集流水线（`collectEntries` / `scanDirectories` / `rankEntries`）
 * **保留但不调用**：留作服务不可用时的对照实现与回归基线，而不是产品路径。
 * 改回 `true` 只会用于排查 opencode 的返回是否异常。
 */
const LOCAL_FILE_COLLECTORS_ENABLED = false;

export interface FileEntry {
	name: string;
	path: string;
	absolutePath: string;
	type: 'file' | 'directory';
	extension?: string;
}

export class FileHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'open_file':
				this.handleOpenFile(content);
				return true;
			case 'resolve_file_path':
				this.handleResolveFilePath(content);
				return true;
			case 'get_linkify_capabilities':
				this.callJavaScript(
					'updateLinkifyCapabilities',
					JSON.stringify({ classNavigationEnabled: false, linkifyCapabilities: { file: true, line: true, url: true } }),
				);
				return true;
			case 'list_files':
				this.handleListFiles(content);
				return true;
			default:
				return false;
		}
	}

	private handleOpenFile(content: string): void {
		let path = content;
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json?.path === 'string') {
				path = json.path;
			} else if (typeof json?.absolutePath === 'string') {
				path = json.absolutePath;
			}
		} catch {
			// content 本身即 path
		}
		path = (path ?? '').trim();
		if (!path) {
			return;
		}
		this.context.getFileOps().openFile(path);
	}

	private handleResolveFilePath(filePath: string): void {
		try {
			const resolvedPath = this.context.getFileOps().resolveFilePath(filePath);
			this.callJavaScript(
				'onFilePathResolved',
				JSON.stringify({ path: filePath, resolvedPath: resolvedPath ?? null }),
			);
		} catch {
			this.callJavaScript(
				'onFilePathResolved',
				JSON.stringify({ path: filePath, resolvedPath: null }),
			);
		}
	}

	// ── list_files ─────────────────────────────────────────────────────────

	/**
	 * 列举候选文件（v2 `files.list` 命令用）。
	 *
	 * 语义与 opencode TUI 的 @ 列表一致：
	 *  - `query` 为空（刚输入 `@`，或 `@src/`）→ `/api/fs/list` 列 `currentPath`
	 *    这一层。`fs.find("")` 返回空集，不能用它做目录导航。
	 *  - `query` 非空 → `/api/fs/find`，query 前缀 `currentPath` 让服务端只在
	 *    该目录（路径前缀）下匹配。
	 * `directory` 由调用方给出 —— 多 tab 下候选必须按**目标 tab 的 cwd** 来，
	 * 而不是窗口级的设置目录。
	 */
	async listFiles(
		query: string,
		currentPath = '',
		directory?: string,
	): Promise<FileEntry[]> {
		if (LOCAL_FILE_COLLECTORS_ENABLED) {
			return this.collectEntries(query, directory);
		}

		const dir = normalizeRelativePath(currentPath);
		const search = (query ?? '').trim();
		try {
			const entries = search
				? await this.findViaDaemon(dir ? `${dir}/${search}` : search, directory)
				: await this.listViaDaemon(dir, directory);
			return entries;
		} catch (err) {
			// GUI 不持有能力：失败就是空列表，由前端提示，而不是拿本地快照冒充成功。
			console.warn(
				`[FileHandler] opencode fs.${search ? 'find' : 'list'} failed: ${String(err)}`,
			);
			return [];
		}
	}

	private handleListFiles(content: string): void {
		let query = '';
		let currentPath = '';
		let requestId: number | null = null;
		try {
			const json = JSON.parse(content ?? '') as {
				query?: unknown;
				currentPath?: unknown;
				requestId?: unknown;
			};
			if (typeof json?.query === 'string') {
				query = json.query;
			}
			if (typeof json?.currentPath === 'string') {
				currentPath = json.currentPath;
			}
			if (typeof json?.requestId === 'number' && Number.isFinite(json.requestId)) {
				requestId = json.requestId;
			}
		} catch {
			// 无 JSON 载荷：视为空 query
		}

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		void this.listFiles(query, currentPath, directory)
			.then((files) => {
				console.log(
					`[FileHandler] list_files query="${query}" path="${currentPath}" -> ${files.length} entries`,
				);
				this.replyFileList(files, requestId);
			})
			.catch(() => this.replyFileList([], requestId));
	}

	/** 有搜索文本：官方 `fs.find`（与 opencode TUI @ 列表同源，服务端已排序）。 */
	private findViaDaemon(query: string, directory?: string): Promise<FileEntry[]> {
		return this.requestEntries(
			'opencode.findFiles',
			{ query, limit: '20', directory },
			directory,
		);
	}

	/** 无搜索文本 / `@dir/`：官方 `fs.list`，列一层目录。 */
	private listViaDaemon(path: string, directory?: string): Promise<FileEntry[]> {
		return this.requestEntries('opencode.listFiles', { path, directory }, directory);
	}

	/**
	 * 通过 daemon 调一个 opencode 文件类命令，把单行 JSON 的 `entries` 映射成
	 * `FileEntry`。失败抛错：调用方决定回空还是降级，不在这里吞掉。
	 */
	private async requestEntries(
		command: 'opencode.findFiles' | 'opencode.listFiles',
		params: Record<string, unknown>,
		directory?: string,
	): Promise<FileEntry[]> {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			throw new Error('daemon unavailable');
		}
		const chunks: string[] = [];
		let daemonError = '';
		const success = await new Promise<boolean>((resolve) => {
			void daemon.request(command, params, {
				onLine: (line) => chunks.push(line),
				onStderr: (text) => {
					for (const line of text.split(/\r?\n/)) {
						if (line.trim()) {
							console.log(`[FileHandler][ai-bridge] ${line.trim()}`);
						}
					}
				},
				onError: (error) => {
					daemonError = error;
					resolve(false);
				},
				onComplete: (ok) => resolve(ok),
			});
		});
		if (!success) {
			throw new Error(daemonError || `${command} failed`);
		}
		const entries = this.extractEntries(chunks.join('\n'));
		const baseDir = directory ?? process.cwd();
		const label = command === 'opencode.listFiles' ? 'list' : 'find';
		console.log(
			`[FileHandler] ${label} ${JSON.stringify(params)} dir=${directory ?? '-'} entries=${entries.length}`,
		);
		return entries.map((entry) => this.toFileEntry(entry, baseDir));
	}

	/** 从 daemon 单行 JSON 输出提取 `{entries:[{path,type}]}`。 */
	private extractEntries(raw: string): Array<{ path: string; type?: string }> {
		for (const line of raw.split(/\r?\n/).reverse()) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('{')) {
				continue;
			}
			try {
				const obj = JSON.parse(trimmed) as { success?: boolean; entries?: unknown };
				if (Array.isArray(obj.entries)) {
					return obj.entries.filter(
						(e): e is { path: string; type?: string } =>
							!!e && typeof (e as { path?: unknown }).path === 'string',
					);
				}
			} catch {
				// 跳过非 JSON 诊断行
			}
		}
		return [];
	}

	private toFileEntry(
		entry: { path: string; type?: string },
		baseDir: string,
	): FileEntry {
		// `/api/fs/list` 返回 `src\host\` 这种混合分隔符 + 目录尾分隔符；
		// 统一成 POSIX 风格并去掉尾部分隔符，否则 basename 会取到空串、点选后
		// 插入的引用路径也会带多余斜杠。
		const relPath = (entry.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
		const absolutePath = isAbsolute(relPath) ? relPath : join(baseDir, relPath);
		const type = entry.type === 'directory' ? 'directory' : 'file';
		return {
			name: basename(relPath),
			path: relPath,
			absolutePath,
			type,
			...(type === 'file' && extname(relPath) ? { extension: extname(relPath).slice(1) } : {}),
		};
	}

	private replyFileList(files: FileEntry[], requestId: number | null): void {
		this.callJavaScript(
			'onFileListResult',
			JSON.stringify(requestId != null ? { files, requestId } : { files }),
		);
	}

	private async collectEntries(query: string, directory?: string): Promise<FileEntry[]> {
		// 只在 LOCAL_FILE_COLLECTORS_ENABLED 打开时才会被调用：保留实现仅作对照。
		// 传目录时只在该目录下采集，与 opencode 的 directory 作用域对齐。
		const roots = directory
			? [directory]
			: (vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []);
		if (roots.length === 0) {
			return [];
		}

		const seen = new Set<string>();
		const entries: FileEntry[] = [];
		/** 打开的编辑器文件置顶（cc-gui「最近/打开的文件」语义）。 */
		const openedPaths: string[] = [];

		const pushEntry = (absolutePath: string, type: 'file' | 'directory'): void => {
			if (seen.has(absolutePath)) {
				return;
			}
			seen.add(absolutePath);
			const name = basename(absolutePath);
			if (EXCLUDED_FILE_NAMES.has(name)) {
				return;
			}
			if (type === 'directory' && (name.startsWith('.') || EXCLUDED_DIR_NAMES.has(name))) {
				return;
			}
			entries.push({
				name,
				path: toWorkspaceRelative(absolutePath, roots),
				absolutePath,
				type,
				...(type === 'file' && extname(absolutePath) ? { extension: extname(absolutePath).slice(1) } : {}),
			});
		};

		for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
			const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
			if (uri && uri.scheme === 'file') {
				openedPaths.push(uri.fsPath);
				pushEntry(uri.fsPath, 'file');
			}
		}

		await Promise.all(
			roots.map(async (root) => {
				try {
					const uris = await vscode.workspace.findFiles(
						new vscode.RelativePattern(vscode.Uri.file(root), '**/*'),
						'**/{node_modules,.git,.idea,dist,out,build,target}/**',
						FIND_FILES_LIMIT_PER_ROOT,
					);
					uris.forEach((u) => pushEntry(u.fsPath, 'file'));
				} catch {
					// 单个 root 失败不阻塞其余 root
				}
			}),
		);

		let dirBudget = DIR_SCAN_MAX_ENTRIES;
		for (const root of roots) {
			await this.scanDirectories(root, 0, pushEntry, () => (dirBudget-- > 0));
		}

		return rankEntries(entries, openedPaths, query);
	}

	private async scanDirectories(
		dir: string,
		depth: number,
		pushEntry: (absolutePath: string, type: 'file' | 'directory') => void,
		hasBudget: () => boolean,
	): Promise<void> {
		if (depth > DIR_SCAN_MAX_DEPTH || !hasBudget()) {
			return;
		}
		let dirents;
		try {
			dirents = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory() || !hasBudget()) {
				continue;
			}
			if (dirent.name.startsWith('.') || EXCLUDED_DIR_NAMES.has(dirent.name)) {
				continue;
			}
			const full = join(dir, dirent.name);
			pushEntry(full, 'directory');
			await this.scanDirectories(full, depth + 1, pushEntry, hasBudget);
		}
	}
}

/**
 * 规范化 @ 输入里拆出的目录前缀：
 * `'src/'` → `'src'`、`'./src/'` → `'src'`、`'src\\host\\'` → `'src/host'`、`''` → `''`。
 *
 * 与 core 的 `normalizeListPath` 同规则：去掉绝对路径与 `..` 段，避免把
 * webview 传来的路径变成越界访问（越界时降级为根目录）。
 */
export function normalizeRelativePath(raw: string): string {
	const value = (raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
		return '';
	}
	if (value.split('/').includes('..')) {
		return '';
	}
	return value;
}

/** 工作区相对路径展示（POSIX 分隔符；跨 root 时取最短匹配）。 */
function toWorkspaceRelative(absolutePath: string, roots: string[]): string {
	let best = absolutePath;
	for (const root of roots) {
		const rel = relative(root, absolutePath);
		if (rel && !rel.startsWith('..') && (best === absolutePath || rel.length < best.length)) {
			best = rel;
		}
	}
	return best.split(sep).join('/');
}

/** 模糊评分（与 webview scoreFileMatch 同表）：精确1000/前缀900/包含800/路径600/子序列400/200。 */
function scoreMatch(name: string, relPath: string, query: string): number {
	const q = query.toLowerCase();
	const n = name.toLowerCase();
	const p = relPath.toLowerCase();
	if (n === q) {return 1000;}
	if (n.startsWith(q)) {return 900;}
	if (n.includes(q)) {return 800;}
	if (p.includes(q)) {return 600;}
	if (isSubsequence(n, q)) {return 400;}
	if (isSubsequence(p, q)) {return 200;}
	return 0;
}

function isSubsequence(text: string, query: string): boolean {
	let ti = 0;
	for (let qi = 0; qi < query.length; qi++) {
		const ch = query[qi];
		while (ti < text.length && text[ti] !== ch) {
			ti++;
		}
		if (ti >= text.length) {
			return false;
		}
		ti++;
	}
	return true;
}

function rankEntries(entries: FileEntry[], openedPaths: string[], query: string): FileEntry[] {
	const openedSet = new Set(openedPaths);

	// 空 query（刚输入 @）：打开的文件置顶，其余按路径字母序全量返回。
	if (!query.trim()) {
		const opened = entries.filter((e) => openedSet.has(e.absolutePath));
		const rest = entries.filter((e) => !openedSet.has(e.absolutePath));
		rest.sort((a, b) => a.path.localeCompare(b.path));
		return [...opened, ...rest].slice(0, RESULT_LIMIT);
	}

	const trimmed = query.trim();
	const scored = entries.map((entry) => ({
		entry,
		score: scoreMatch(entry.name, entry.path, trimmed),
	}));

	const matched = scored.filter((s) => s.score > 0);
	matched.sort((a, b) => {
		if (b.score !== a.score) {return b.score - a.score;}
		return a.entry.path.length - b.entry.path.length || a.entry.name.localeCompare(b.entry.name);
	});
	return matched.slice(0, RESULT_LIMIT).map((s) => s.entry);
}
