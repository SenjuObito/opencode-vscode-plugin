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
	const candidates: Array<string | null> = [
		'opencode',
		process.env.OPENCODE_BINARY ?? null,
		`${process.env.HOME ?? ''}/.local/bin/opencode`,
		'/usr/local/bin/opencode',
	];
	const tried = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);
		try {
			const result = spawnSync(candidate, ['--version'], {
				encoding: 'utf8',
				timeout: 5000,
				shell: process.platform === 'win32',
			});
			if (result.status === 0 && result.stdout) {
				return { path: candidate, version: result.stdout.trim() };
			}
		} catch {
			// 继续尝试下一个候选
		}
	}
	return null;
}
