/**
 * SkillService — opencode skill management (scan / import / delete / toggle).
 *
 * opencode skill layout:
 *   Enabled:  ~/.config/opencode/skills/{skill-name}/SKILL.md
 *   Disabled: ~/.config/opencode/skills-disabled/{skill-name}/SKILL.md
 *
 * Port of cc-gui SkillService.java for opencode-only.
 */
import { promises as fsp } from 'fs';
import { join, basename, resolve, relative } from 'path';
import { homedir } from 'os';
import { parseSkillMetadata } from './SkillFrontmatterParser';

// ── Types ──────────────────────────────────────────────────────────────────

export type SkillScope = 'global' | 'local' | 'user' | 'repo';
export type SkillType = 'file' | 'directory';

export interface Skill {
	id: string;
	name: string;
	type: SkillType;
	scope: SkillScope;
	path: string;
	enabled: boolean;
	description?: string;
	skillPath?: string;
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

const OPENCODE_SKILLS_DIR = join(homedir(), '.config', 'opencode', 'skills');
const OPENCODE_SKILLS_DISABLED_DIR = join(homedir(), '.config', 'opencode', 'skills-disabled');

function getLocalSkillsDir(workspaceRoot: string): string {
	return join(workspaceRoot, '.opencode', 'skills');
}

const VALID_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;

// ── Path safety ────────────────────────────────────────────────────────────

function isPathClean(path: string): boolean {
	if (path.includes('\0')) {
		return false;
	}
	const normalized = resolve(path);
	return normalized === path;
}

function isInsideDirectory(filePath: string, dir: string): boolean {
	const resolved = resolve(filePath);
	const resolvedDir = resolve(dir);
	return resolved.startsWith(resolvedDir + '/') || resolved === resolvedDir;
}

function isSafeSkillName(name: string): boolean {
	if (!name || name.length > MAX_NAME_LENGTH) {
		return false;
	}
	return VALID_NAME_RE.test(name);
}

// ── Directory helpers ──────────────────────────────────────────────────────

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

async function removeDir(dir: string): Promise<void> {
	await fsp.rm(dir, { recursive: true, force: true });
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

async function moveDirRecursive(src: string, dest: string): Promise<void> {
	try {
		// Try atomic move first (same filesystem)
		await fsp.rename(src, dest);
	} catch {
		// Cross-filesystem: copy + delete
		await copyDirRecursive(src, dest);
		await removeDir(src);
	}
}

// ── Core service ───────────────────────────────────────────────────────────

export class SkillService {
	/**
	 * Scan all skill directories and return the full skills config.
	 * If workspaceRoot is provided, also scan .opencode/skills/ for local skills.
	 */
	static async getAllSkills(workspaceRoot?: string | null): Promise<SkillsConfig> {
		const tasks: Promise<SkillsMap>[] = [
			SkillService.scanSkillsDir(OPENCODE_SKILLS_DIR, 'global', true),
			SkillService.scanSkillsDir(OPENCODE_SKILLS_DISABLED_DIR, 'global', false),
		];

		if (workspaceRoot) {
			const localDir = getLocalSkillsDir(workspaceRoot);
			const localDisabledDir = join(workspaceRoot, '.opencode', 'skills-disabled');
			tasks.push(SkillService.scanSkillsDir(localDir, 'local', true));
			tasks.push(SkillService.scanSkillsDir(localDisabledDir, 'local', false));
		}

		const results = await Promise.all(tasks);

		// Merge global enabled + disabled into global map
		const global: SkillsMap = { ...results[0], ...results[1] };

		// Local skills: merge enabled (index 2) + disabled (index 3)
		const local: SkillsMap = workspaceRoot
			? { ...(results[2] ?? {}), ...(results[3] ?? {}) }
			: {};

		return {
			global,
			local,
		};
	}

	/**
	 * Scan a single skills directory for skill entries.
	 */
	private static async scanSkillsDir(
		dirPath: string,
		scope: SkillScope,
		enabled: boolean,
	): Promise<SkillsMap> {
		const result: SkillsMap = {};

		let entries;
		try {
			entries = await fsp.readdir(dirPath, { withFileTypes: true });
		} catch {
			// Directory doesn't exist yet — normal for fresh install
			return result;
		}

		for (const entry of entries) {
			// Skip hidden files
			if (entry.name.startsWith('.')) {
				continue;
			}

			const entryPath = join(dirPath, entry.name);
			const name = entry.name;

			// Parse frontmatter for metadata
			let description = '';
			const metadata = await parseSkillMetadata(entryPath);
			if (metadata) {
				description = metadata.description;
			}

			// Get file stats
			let createdAt: string | undefined;
			let modifiedAt: string | undefined;
			try {
				const stat = await fsp.stat(entryPath);
				createdAt = stat.birthtime?.toISOString();
				modifiedAt = stat.mtime?.toISOString();
			} catch {
				// ignore
			}

			const id = enabled
				? `${scope}-${name}`
				: `${scope}-${name}-disabled`;

			result[id] = {
				id,
				name,
				type: entry.isDirectory() ? 'directory' : 'file',
				scope,
				path: entryPath,
				enabled,
				description,
				createdAt,
				modifiedAt,
			};
		}

		return result;
	}

	/**
	 * Import skills from source paths into the skills directory.
	 * When scope is 'local', imports into .opencode/skills/ under workspaceRoot.
	 * When scope is 'global', imports into ~/.config/opencode/skills/.
	 */
	static async importSkills(
		sourcePaths: string[],
		scope: SkillScope,
		workspaceRoot?: string | null,
	): Promise<ImportResult> {
		const targetDir = scope === 'local' && workspaceRoot
			? getLocalSkillsDir(workspaceRoot)
			: OPENCODE_SKILLS_DIR;
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
			if (await dirExists(targetPath)) {
				result.errors.push(`Skill already exists: ${skillName}`);
				continue;
			}

			// Copy to target
			try {
				const stat = await fsp.stat(resolved);
				if (stat.isDirectory()) {
					await copyDirRecursive(resolved, targetPath);
				} else {
					// Single file — create directory and copy
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
	 * Delete a skill by name and scope.
	 */
	static async deleteSkill(
		name: string,
		scope: SkillScope,
		enabled: boolean,
		workspaceRoot?: string | null,
	): Promise<DeleteResult> {
		if (!isSafeSkillName(name)) {
			return { success: false, error: `Invalid skill name: ${name}` };
		}

		let baseDir: string;
		if (scope === 'local' && workspaceRoot) {
			baseDir = getLocalSkillsDir(workspaceRoot);
		} else {
			baseDir = enabled ? OPENCODE_SKILLS_DIR : OPENCODE_SKILLS_DISABLED_DIR;
		}
		const skillDir = join(baseDir, name);

		// Validate path is inside skills directory
		if (!isInsideDirectory(skillDir, baseDir)) {
			return { success: false, error: 'Invalid skill path' };
		}

		try {
			await fsp.access(skillDir);
		} catch {
			return { success: false, error: `Skill not found: ${name}` };
		}

		try {
			await removeDir(skillDir);
			return { success: true };
		} catch (err) {
			return { success: false, error: `Failed to delete: ${String(err)}` };
		}
	}

	/**
	 * Toggle a skill between enabled and disabled states.
	 * Moves the skill directory between active and disabled directories.
	 * For local skills, uses .opencode/skills/ and .opencode/skills-disabled/.
	 */
	static async toggleSkill(
		name: string,
		scope: SkillScope,
		currentEnabled: boolean,
		workspaceRoot?: string | null,
	): Promise<ToggleResult> {
		if (!isSafeSkillName(name)) {
			return { success: false, error: `Invalid skill name: ${name}` };
		}

		let sourceDir: string;
		let targetDir: string;
		if (scope === 'local' && workspaceRoot) {
			const localDir = getLocalSkillsDir(workspaceRoot);
			const localDisabledDir = join(workspaceRoot, '.opencode', 'skills-disabled');
			sourceDir = currentEnabled ? localDir : localDisabledDir;
			targetDir = currentEnabled ? localDisabledDir : localDir;
		} else {
			sourceDir = currentEnabled ? OPENCODE_SKILLS_DIR : OPENCODE_SKILLS_DISABLED_DIR;
			targetDir = currentEnabled ? OPENCODE_SKILLS_DISABLED_DIR : OPENCODE_SKILLS_DIR;
		}
		const sourcePath = join(sourceDir, name);
		const targetPath = join(targetDir, name);

		// Validate paths
		if (!isInsideDirectory(sourcePath, sourceDir)) {
			return { success: false, error: 'Invalid skill path' };
		}

		// Check source exists
		try {
			await fsp.access(sourcePath);
		} catch {
			return { success: false, error: `Skill not found: ${name}` };
		}

		// Check no conflict at target
		if (await dirExists(targetPath)) {
			return { success: false, error: `Skill already exists at target: ${name}` };
		}

		// Ensure target directory exists
		await ensureDir(targetDir);

		// Move
		try {
			await moveDirRecursive(sourcePath, targetPath);
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
			// Try SKILL.md then skill.md
			const candidates = ['SKILL.md', 'skill.md'];
			for (const name of candidates) {
				const p = join(skillPath, name);
				try {
					await fsp.access(p);
					return p;
				} catch {
					// continue
				}
			}
			return null;
		}

		return skillPath;
	}
}
