/**
 * OpenCodeCliLocator — locates the local `opencode` binary and reads its
 * version. Shared by DependencyHandler (依赖管理) and CliStatusHandler
 * (供应商管理 CLI 检测).
 */
import { spawnSync } from 'child_process';

export interface OpenCodeCliInfo {
	path: string;
	version: string;
}

export function findOpenCodeCli(): OpenCodeCliInfo | null {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	// Base candidates (no extension). Mirrors cli-path.js / the Java
	// CliStatusDetector: OPENCODE_BIN (primary), with OPENCODE_BINARY kept for
	// backward compatibility. Also covers the official installer location
	// (~/.opencode/bin) that the previous implementation missed.
	const baseCandidates: Array<string | null> = [
		'opencode',
		process.env.OPENCODE_BIN ?? process.env.OPENCODE_BINARY ?? null,
		home ? `${home}/.opencode/bin/opencode` : null,
		home ? `${home}/.local/bin/opencode` : null,
		'/usr/local/bin/opencode',
	];
	const win = process.platform === 'win32';
	// On Windows npm/pnpm installs ship .cmd/.exe shims; try those first.
	const exts = win ? ['.cmd', '.exe', ''] : [''];
	const tried = new Set<string>();
	for (const base of baseCandidates) {
		if (!base) {
			continue;
		}
		for (const ext of exts) {
			const candidate = base + ext;
			if (!candidate || tried.has(candidate)) {
				continue;
			}
			tried.add(candidate);
			try {
				const result = spawnSync(candidate, ['--version'], {
					encoding: 'utf8',
					timeout: 5000,
					shell: win,
				});
				if (result.status === 0 && result.stdout) {
					return { path: candidate, version: result.stdout.trim() };
				}
			} catch {
				// 继续尝试下一个候选
			}
		}
	}
	return null;
}
