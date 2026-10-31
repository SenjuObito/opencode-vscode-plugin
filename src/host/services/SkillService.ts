/**
 * SkillService — opencode skill management (scan / import / delete / toggle).
 *
 * opencode 的 skill 目录随版本演进，插件必须同时认 v1（单数）与 v2（复数）：
 *
 *   Enabled (global):
 *     ~/.config/opencode/skills   ~/.config/opencode/skill
 *     ~/.opencode/skills          ~/.opencode/skill
 *     ~/.claude/skills            ~/.agents/skills
 *   Enabled (project):
 *     {ws}/.opencode/skills       {ws}/.opencode/skill
 *     {ws}/.claude/skills         {ws}/.agents/skills
 *   Disabled (managed by this plugin only):
 *     ~/.config/opencode/skills-disabled
 *     {ws}/.opencode/skills-disabled
 *
 * v2 的发现规则比 v1 宽（见 https://opencode.ai/v2/docs/skills）：
 *   - 根级 `*.md` 也算一个 skill（type=file）
 *   - `dir/SKILL.md` 是目录型 skill
 *   - 分组目录（`skills/teams/release/SKILL.md`）最多向下找 6 层
 *   - 跳过隐藏项与 node_modules
 *
 * Skill 的 `name` 来自 frontmatter 的显示名，`skillId` 才是磁盘上的
 * 目录名 / 文件名 —— 删除、启停都必须用 skillId，否则 v2 里
 * `name: Git Release` + 目录 `git-release` 会定位不到。
 *
 * Port of cc-gui SkillService.java for opencode-only.
 */
import { existsSync, promises as fsp } from 'fs';
import { join, basename, resolve, sep } from 'path';
import { homedir } from 'os';
import { parseSkillMetadata } from './SkillFrontmatterParser';

// ── Types ──────────────────────────────────────────────────────────────────

export type SkillScope = 'global' | 'local' | 'user' | 'repo';
export type SkillType = 'file' | 'directory';

export interface Skill {
	id: string;
	/** 磁盘上的标识（目录名，或根级 md 去掉扩展名）；删除/启停用它。 */
	skillId: string;
	/** 显示名（frontmatter `name`，缺失时回退 skillId）。 */
	name: string;
	type: SkillType;
	scope: SkillScope;
	path: string;
	enabled: boolean;
	/** 该 skill 是被哪个根目录扫到的（只读信息 + 迁移时的来源）。 */
	sourceDir: string;
	description?: string;
	skillPath?: string;
	/** frontmatter 解析失败时的标记（如 `invalid_frontmatter`）。 */
	warning?: string;
	createdAt?: string;
	modifiedAt?: string;
}

export type SkillsMap = Record<string, Skill>;

export interface SkillsConfig {
	global: SkillsMap;
	local: SkillsMap;
	user?: SkillsMap;
	repo?: SkillsMap;
}

export interface SkillScanOptions {
	/** 覆盖 home 目录（测试注入用）。 */
	homeDir?: string;
}

export interface ImportResult {
	success: boolean;
	count: number;
	total: number;
	imported: string[];
	errors: string[];
}

export interface DeleteResult {
	success: boolean;
	error?: string;
}

export interface ToggleResult {
	success: boolean;
	name?: string;
	enabled?: boolean;
	error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** SKILL.md 允许的大小写变体。 */
const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md'];

/** v2 允许分组目录，最多向下找 6 层。 */
const MAX_SCAN_DEPTH = 6;

const VALID_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;

// ── Directory layout ───────────────────────────────────────────────────────

function configOpencodeDir(home: string): string {
	return join(home, '.config', 'opencode');
}

/**
 * 全局活动目录，按「优先级从低到高」排列。
 *
 * 后面的目录会覆盖前面同名 skill，与 opencode v2 的来源覆盖顺序一致
 * （.claude → .agents → ~/.config/opencode → ~/.opencode）。
 */
function globalActiveDirs(home = homedir()): string[] {
	const configDir = configOpencodeDir(home);
	return [
		join(home, '.claude', 'skills'),
		join(home, '.agents', 'skills'),
		join(configDir, 'skill'),
		join(configDir, 'skills'),
		join(home, '.opencode', 'skill'),
		join(home, '.opencode', 'skills'),
	];
}

function localActiveDirs(workspaceRoot: string): string[] {
	const opencodeDir = join(workspaceRoot, '.opencode');
	return [
		join(workspaceRoot, '.claude', 'skills'),
		join(workspaceRoot, '.agents', 'skills'),
		join(opencodeDir, 'skill'),
		join(opencodeDir, 'skills'),
	];
}

function globalDisabledDir(home = homedir()): string {
	return join(configOpencodeDir(home), 'skills-disabled');
}

function localDisabledDir(workspaceRoot: string): string {
	return join(workspaceRoot, '.opencode', 'skills-disabled');
}

/** 导入 / 启用时的目标目录：优先沿用磁盘上已存在的布局（v1 单数或 v2 复数）。 */
function resolvePrimaryActiveDir(scope: SkillScope, workspaceRoot?: string | null, home = homedir()): string | null {
	if (scope === 'local' || scope === 'repo') {
		if (!workspaceRoot) {
			return null;
		}
		const opencodeDir = join(workspaceRoot, '.opencode');
		return pickExistingDir([join(opencodeDir, 'skills'), join(opencodeDir, 'skill')]);
	}
	return pickExistingDir([
		join(configOpencodeDir(home), 'skills'),
		join(configOpencodeDir(home), 'skill'),
		join(home, '.opencode', 'skills'),
	]);
}

function pickExistingDir(candidates: string[]): string {
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return candidates[0];
}

// ── Path safety ────────────────────────────────────────────────────────────

function isInsideDirectory(filePath: string, dir: string): boolean {
	const resolved = resolve(filePath);
	const resolvedDir = resolve(dir).replace(new RegExp(`\\${sep}$`), '');
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
}

function isSafeSkillName(name: string): boolean {
	if (!name || name.length > MAX_NAME_LENGTH) {
		return false;
	}
	return VALID_NAME_RE.test(name);
}

/**
 * skillId 来自真实文件名，可能含大写、下划线、点号，因此只拦路径穿越。
 */
function isSafeSkillId(skillId: string): boolean {
	if (!skillId || skillId.length > 128) {
		return false;
	}
	if (skillId === '.' || skillId === '..') {
		return false;
	}
	return !/[/\\\0]/.test(skillId);
}

// ── Filesystem helpers ─────────────────────────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
	try {
		await fsp.stat(path);
		return true;
	} catch {
		return false;
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(path);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function ensureDir(dir: string): Promise<void> {
	await fsp.mkdir(dir, { recursive: true });
}

/** 文件或目录都能删（`rm -rf` 语义）。 */
async function removePath(path: string): Promise<void> {
	await fsp.rm(path, { recursive: true, force: true });
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
	await ensureDir(dest);
	const entries = await fsp.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDirRecursive(srcPath, destPath);
		} else {
			await fsp.copyFile(srcPath, destPath);
		}
	}
}

async function movePath(src: string, dest: string): Promise<void> {
	try {
		// Try atomic move first (same filesystem)
		await fsp.rename(src, dest);
	} catch {
		// Cross-filesystem: copy + delete
		const stat = await fsp.stat(src);
		if (stat.isDirectory()) {
			await copyDirRecursive(src, dest);
		} else {
			await fsp.copyFile(src, dest);
		}
		await removePath(src);
	}
}

async function hasSkillFile(dir: string): Promise<boolean> {
	for (const name of SKILL_FILE_NAMES) {
		if (await pathExists(join(dir, name))) {
			return true;
		}
	}
	return false;
}

// ── Discovery ──────────────────────────────────────────────────────────────

interface DiscoveredSkill {
	skillId: string;
	path: string;
	type: SkillType;
}

async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
	const found: DiscoveredSkill[] = [];
	const seen = new Set<string>();
	await walkSkillsDir(root, 0, found, seen);
	return found;
}

async function walkSkillsDir(
	dir: string,
	depth: number,
	out: DiscoveredSkill[],
	seen: Set<string>,
): Promise<void> {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		// 目录不存在是常态（全新安装）
		return;
	}
	// 稳定顺序，避免不同文件系统上的列表抖动
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const name = entry.name;
		if (name.startsWith('.') || name === 'node_modules') {
			continue;
		}
		const entryPath = join(dir, name);

		if (entry.isFile()) {
			// v2：只有根级 *.md 才是 file skill，嵌套文档不算
			if (depth === 0) {
				const match = /^(.+)\.md$/i.exec(name);
				if (match && isSafeSkillId(match[1]) && !seen.has(match[1])) {
					seen.add(match[1]);
					out.push({ skillId: match[1], path: entryPath, type: 'file' });
				}
			}
			continue;
		}

		if (!entry.isDirectory()) {
			continue;
		}

		if (await hasSkillFile(entryPath)) {
			if (isSafeSkillId(name) && !seen.has(name)) {
				seen.add(name);
				out.push({ skillId: name, path: entryPath, type: 'directory' });
			}
			// skill 目录内部的 md 是文档/示例，不再向下挖
			continue;
		}

		// 分组目录（v2 的 skills/teams/release/SKILL.md）
		if (depth + 1 <= MAX_SCAN_DEPTH) {
			await walkSkillsDir(entryPath, depth + 1, out, seen);
		}
	}
}

async function toSkill(
	found: DiscoveredSkill,
	scope: SkillScope,
	enabled: boolean,
	sourceDir: string,
): Promise<Skill> {
	const metadata = await parseSkillMetadata(found.path);
	const id = `${scope}-${found.skillId}${enabled ? '' : '-disabled'}`;

	let createdAt: string | undefined;
	let modifiedAt: string | undefined;
	try {
		const stat = await fsp.stat(found.path);
		createdAt = stat.birthtime?.toISOString();
		modifiedAt = stat.mtime?.toISOString();
	} catch {
		// ignore
	}

	return {
		id,
		skillId: found.skillId,
		name: metadata?.name?.trim() || found.skillId,
		type: found.type,
		scope,
		path: found.path,
		enabled,
		sourceDir,
		description: metadata?.description ?? '',
		...(metadata ? {} : { warning: 'invalid_frontmatter' }),
		createdAt,
		modifiedAt,
	};
}

async function collectScope(
	scope: SkillScope,
	activeDirs: string[],
	disabledDirs: string[],
): Promise<SkillsMap> {
	const bySkillId = new Map<string, Skill>();

	// 活动目录：后扫到的覆盖先扫到的（优先级见 globalActiveDirs）
	for (const dir of activeDirs) {
		for (const found of await discoverSkills(dir)) {
			const skill = await toSkill(found, scope, true, dir);
			bySkillId.set(found.skillId, skill);
		}
	}

	// 停用目录：同名时活动版本优先（与 IDEA 的 first-wins 去重一致）
	for (const dir of disabledDirs) {
		for (const found of await discoverSkills(dir)) {
			if (bySkillId.has(found.skillId)) {
				continue;
			}
			const skill = await toSkill(found, scope, false, dir);
			bySkillId.set(found.skillId, skill);
		}
	}

	const map: SkillsMap = {};
	for (const skill of bySkillId.values()) {
		map[skill.id] = skill;
	}
	return map;
}

// ── Core service ───────────────────────────────────────────────────────────

export class SkillService {
	/**
	 * Scan all skill directories and return the full skills config.
	 * If workspaceRoot is provided, also scan project-level skill dirs.
	 */
	static async getAllSkills(
		workspaceRoot?: string | null,
		options?: SkillScanOptions,
	): Promise<SkillsConfig> {
		const home = options?.homeDir ?? homedir();
		const global = await collectScope(
			'global',
			globalActiveDirs(home),
			[globalDisabledDir(home)],
		);

		if (!workspaceRoot) {
			return { global, local: {} };
		}

		const local = await collectScope(
			'local',
			localActiveDirs(workspaceRoot),
			[localDisabledDir(workspaceRoot)],
		);
		return { global, local };
	}

	/**
	 * Import skills from source paths into the skills directory.
	 * When scope is 'local', imports into {ws}/.opencode/skills|skill/.
	 * When 'global', imports into ~/.config/opencode/skills|skill/.
	 */
	static async importSkills(
		sourcePaths: string[],
		scope: SkillScope,
		workspaceRoot?: string | null,
	): Promise<ImportResult> {
		const targetDir = resolvePrimaryActiveDir(scope, workspaceRoot);
		if (!targetDir) {
			return {
				success: false,
				count: 0,
				total: sourcePaths.length,
				imported: [],
				errors: ['Unable to resolve skills directory'],
			};
		}
		await ensureDir(targetDir);

		const result: ImportResult = {
			success: true,
			count: 0,
			total: sourcePaths.length,
			imported: [],
			errors: [],
		};

		for (const sourcePath of sourcePaths) {
			const resolved = resolve(sourcePath);

			// Validate source exists
			try {
				await fsp.access(resolved);
			} catch {
				result.errors.push(`Source not found: ${sourcePath}`);
				continue;
			}

			// Determine skill name from source path
			const skillName = basename(resolved);

			// Validate name safety
			if (!isSafeSkillName(skillName)) {
				result.errors.push(`Invalid skill name: ${skillName}`);
				continue;
			}

			// Check name collision
			const targetPath = join(targetDir, skillName);
			if (await pathExists(targetPath)) {
				result.errors.push(`Skill already exists: ${skillName}`);
				continue;
			}

			// Copy to target — v1/v2 都认 `<name>/SKILL.md`
			try {
				const stat = await fsp.stat(resolved);
				if (stat.isDirectory()) {
					await copyDirRecursive(resolved, targetPath);
				} else {
					// Single file — create directory and copy as SKILL.md
					await ensureDir(targetPath);
					await fsp.copyFile(resolved, join(targetPath, 'SKILL.md'));
				}
				result.count++;
				result.imported.push(skillName);
			} catch (err) {
				result.errors.push(`Failed to import ${skillName}: ${String(err)}`);
			}
		}

		result.success = result.errors.length === 0;
		return result;
	}

	/**
	 * Delete a skill by its path-derived skillId.
	 *
	 * `pathHint`（webview 上已经持有的绝对路径）优先，但必须落在该 scope
	 * 允许的目录内；否则按 skillId 在候选目录里查找。
	 */
	static async deleteSkill(
		skillId: string,
		scope: SkillScope,
		enabled: boolean,
		workspaceRoot?: string | null,
		pathHint?: string | null,
	): Promise<DeleteResult> {
		if (!isSafeSkillId(skillId)) {
			return { success: false, error: `Invalid skill id: ${skillId}` };
		}

		const roots = enabled
			? (scope === 'local' ? localActiveDirs(workspaceRoot ?? '') : globalActiveDirs())
			: [scope === 'local' ? localDisabledDir(workspaceRoot ?? '') : globalDisabledDir()];

		const candidates: string[] = [];
		if (pathHint) {
			const resolvedHint = resolve(pathHint);
			if (roots.some((root) => isInsideDirectory(resolvedHint, root))) {
				candidates.push(resolvedHint);
			}
		}
		for (const root of roots) {
			candidates.push(join(root, skillId));
			candidates.push(join(root, `${skillId}.md`));
		}

		for (const candidate of candidates) {
			if (!(await pathExists(candidate))) {
				continue;
			}
			if (!roots.some((root) => isInsideDirectory(candidate, root))) {
				continue;
			}
			try {
				await removePath(candidate);
				return { success: true };
			} catch (err) {
				return { success: false, error: `Failed to delete: ${String(err)}` };
			}
		}

		return { success: false, error: `Skill not found: ${skillId}` };
	}

	/**
	 * Toggle a skill between enabled and disabled states.
	 *
	 * 停用：从任意活动目录移到本插件的停用目录（保留文件名/目录名）。
	 * 启用：从停用目录移回主活动目录（沿用磁盘上已有的 v1/v2 布局）。
	 */
	static async toggleSkill(
		skillId: string,
		scope: SkillScope,
		currentEnabled: boolean,
		workspaceRoot?: string | null,
		pathHint?: string | null,
	): Promise<ToggleResult> {
		if (!isSafeSkillId(skillId)) {
			return { success: false, error: `Invalid skill id: ${skillId}` };
		}

		const local = scope === 'local';
		const activeDirs = local ? localActiveDirs(workspaceRoot ?? '') : globalActiveDirs();
		const disabledDir = local ? localDisabledDir(workspaceRoot ?? '') : globalDisabledDir();

		const source = await locateSkillPath(skillId, currentEnabled, activeDirs, disabledDir, pathHint);
		if (!source) {
			return {
				success: false,
				error: `Skill not found: ${skillId}`,
			};
		}

		const isFile = !(await dirExists(source));
		const targetDir = currentEnabled
			? disabledDir
			: resolvePrimaryActiveDir(scope, workspaceRoot);
		if (!targetDir) {
			return { success: false, error: 'Unable to resolve skills directory' };
		}

		const target = join(targetDir, isFile ? `${skillId}.md` : skillId);
		if (await pathExists(target)) {
			return {
				success: false,
				error: `Skill already exists at target: ${skillId}`,
			};
		}

		try {
			await ensureDir(targetDir);
			await movePath(source, target);
			return { success: true };
		} catch (err) {
			return { success: false, error: `Failed to toggle: ${String(err)}` };
		}
	}

	/**
	 * Open a skill file for editing in VS Code.
	 * Returns the path to open — caller uses FileOps.openFile.
	 */
	static async resolveOpenPath(skillPath: string): Promise<string | null> {
		let stat;
		try {
			stat = await fsp.stat(skillPath);
		} catch {
			return null;
		}

		if (stat.isDirectory()) {
			for (const name of SKILL_FILE_NAMES) {
				const p = join(skillPath, name);
				if (await pathExists(p)) {
					return p;
				}
			}
			return null;
		}

		return skillPath;
	}
}

/** 定位一个 skill 在磁盘上的实际路径（文件或目录）。 */
async function locateSkillPath(
	skillId: string,
	enabled: boolean,
	activeDirs: string[],
	disabledDir: string,
	pathHint?: string | null,
): Promise<string | null> {
	const roots = enabled ? activeDirs : [disabledDir];

	if (pathHint) {
		const hint = resolve(pathHint);
		if (roots.some((root) => isInsideDirectory(hint, root)) && (await pathExists(hint))) {
			return hint;
		}
	}

	for (const root of roots) {
		for (const candidate of [join(root, skillId), join(root, `${skillId}.md`)]) {
			if (await pathExists(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}
