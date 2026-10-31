/**
 * CliPathAutoFill — 把 daemon 自己解析出的 opencode 二进制路径回写进设置。
 *
 * 移植自 IDEA 插件 `bridge/CliPathAutoFill.java`（及 `OpenCodeCliPathHandler`
 * 的路径校验），语义逐条对齐。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * daemon 用 `utils/cli-path.js` 按 L0 设置 → L1 env → L2 已知目录 → L3 PATH →
 * L4 裸名 解析，并通过 `engine_status.cliPath` / `cliSource` 报告结果。没有这
 * 一步，设置为空时会一直为空，插件却在用一个用户看不见的二进制——设置页在说
 * 谎，用户也无从知道实际启动的是哪一个。
 *
 * ── 为什么只信 daemon 的值 ────────────────────────────────────────────────
 * 宿主再扫一遍就是第二套候选表/第二套顺序，保存下来的值可能与下次真正 spawn
 * 的二进制不一致。daemon 解析出的 `cliPath` 按定义就是 `findBinary()` 将要拿到
 * 的那一个，它是唯一权威。
 *
 * ── 刻意不做的事 ─────────────────────────────────────────────────────────
 * 1. 不覆盖：设置非空时永不动它（用户显式选择优先于任何自动发现）。
 * 2. 不重扫：决策只是对 daemon 报告做一次纯判断。
 * 3. 不抛错：回填是便利功能，写失败不能影响 daemon 或设置页。
 * 4. 不填裸名：L4 的 `opencode` 不是路径，写回后 L0 只接受路径，等于无效。
 */
import { statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** {@code cliSource} 中表示「这个值来自设置本身」的取值。 */
const SOURCE_SETTINGS = 'settings';

/** 回填所需的最小设置接口（`SettingsService` 结构上满足，测试可传内存实现）。 */
export interface CliPathSettingsStore {
	/** 当前持久化的 opencode CLI 路径，未配置时返回 null。 */
	getOpencodeCliPath(): string | null;
	/** 当前值是否是插件自动探测填进去的。 */
	getOpencodeCliPathAutoDetected(): boolean;
	/** 持久化一个 daemon 解析出的路径，并标记为自动检测。 */
	setOpencodeCliPathAutoDetected(path: string | null): void;
	/** 持久化用户手填的路径（清除自动检测标记）。 */
	setOpencodeCliPath(path: string | null): void;
}

/** 宿主文件系统/平台探针，测试注入用。 */
export interface CliPathProbe {
	/** 该路径是否是一个存在的文件。 */
	isFile(path: string): boolean;
	/** 宿主平台，默认 `process.platform`。 */
	platform: NodeJS.Platform;
	/** 用户 home，默认 `os.homedir()`。 */
	home: string;
}

const defaultProbe: CliPathProbe = {
	isFile: (path: string) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	},
	platform: process.platform,
	home: homedir(),
};

/** Windows 上以 `/` 开头的路径是 WSL 里的 Linux 路径。 */
export function isWslPath(path: string | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'win32' && typeof path === 'string' && path.startsWith('/');
}

function probeWith(overrides?: Partial<CliPathProbe>): CliPathProbe {
	return overrides ? { ...defaultProbe, ...overrides } : defaultProbe;
}

/**
 * 是否应该把这个解析结果写回设置。
 *
 * @param cliPath   `engine_status.cliPath`（可为空）
 * @param cliSource `engine_status.cliSource`（可为空）
 * @param current   设置里当前持有的值
 * @param probe     文件/平台探针（测试注入）
 * @returns true = 设置为空且解析结果可用
 */
export function shouldFill(
	cliPath: string | null | undefined,
	cliSource: string | null | undefined,
	current: string | null | undefined,
	probe?: Partial<CliPathProbe>,
): boolean {
	const path = typeof cliPath === 'string' ? cliPath.trim() : '';
	if (path === '') {
		return false;
	}
	if (cliSource === SOURCE_SETTINGS) {
		// 设置自己的值被读回来：没有新信息，重写只会每次启动都动一次存储。
		return false;
	}
	if (typeof current === 'string' && current.trim() !== '') {
		return false;
	}
	// 裸命令名（L4）不是路径；L0 只接受路径，写回等于把 PATH 查找禁掉。
	if (!path.includes('/') && !path.includes('\\')) {
		return false;
	}
	const p = probeWith(probe);
	if (isWslPath(path, p.platform)) {
		// WSL 里的 Linux 路径宿主无法校验：每个合法路径都会看起来「不存在」。
		// 信任 daemon——它是在真正执行的那个命名空间里解析出来的。
		return true;
	}
	return p.isFile(path);
}

/**
 * 谓词允许时执行回填。
 *
 * @returns `applied` 是真正写入的路径；未写入时为 null。调用方广播新值时必须
 *          用它，**不要回读设置**：Memento 的写入是异步的，紧接着 `get` 可能
 *          拿到旧值。
 */
export function applyAutoFill(
	store: CliPathSettingsStore | null | undefined,
	cliPath: string | null | undefined,
	cliSource: string | null | undefined,
	probe?: Partial<CliPathProbe>,
): { applied: string | null } {
	if (!store) {
		return { applied: null };
	}
	try {
		const current = store.getOpencodeCliPath();
		const path = typeof cliPath === 'string' ? cliPath.trim() : '';
		if (path === '' || !shouldFill(path, cliSource, current, probe)) {
			return { applied: null };
		}
		store.setOpencodeCliPathAutoDetected(path);
		return { applied: path };
	} catch {
		// 便利功能：只读存储或并发写入不能变成 daemon 侧的错误。
		return { applied: null };
	}
}

/**
 * 注入 L0（`OPENCODEBUDDY_CLI_PATH`）前取路径。
 *
 * 自动检测填进去的值如果已经不存在，就地丢弃并清空设置，让 daemon 重新扫描；
 * 用户手填的值保持相反的语义（L0 缺失 → settings-invalid 阻塞），因为那是用户
 * 的选择，静默回落只会把打错字藏起来。
 *
 * WSL 路径永远不在这里判断：宿主 `fs` 看不到 WSL 命名空间。
 */
export function resolveCliPathForInjection(
	store: CliPathSettingsStore | null | undefined,
	probe?: Partial<CliPathProbe>,
): string | null {
	if (!store) {
		return null;
	}
	try {
		const path = store.getOpencodeCliPath();
		if (!path) {
			return null;
		}
		const p = probeWith(probe);
		if (isWslPath(path, p.platform)) {
			return path;
		}
		if (!store.getOpencodeCliPathAutoDetected()) {
			return path;
		}
		if (p.isFile(path)) {
			return path;
		}
		store.setOpencodeCliPath(null);
		return null;
	} catch {
		return null;
	}
}

/**
 * 校验并规范化用户手填的路径（IDEA `OpenCodeCliPathHandler.resolveValidCliPath`）。
 *
 * @returns 规范化后的绝对路径；无法解析/不存在时返回 null。WSL 路径原样返回，
 *          因为宿主 `fs` 无法判断它在 WSL 里是否存在。
 */
export function resolveValidCliPath(
	input: string | null | undefined,
	probe?: Partial<CliPathProbe>,
): string | null {
	if (typeof input !== 'string' || input.trim() === '') {
		return null;
	}
	const p = probeWith(probe);

	let cleaned = input.trim();
	// 资源管理器/终端复制来的路径常带成对引号。
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"'))
		|| (cleaned.startsWith("'") && cleaned.endsWith("'"))
	) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	if (cleaned === '') {
		return null;
	}

	// 先决定锚点再展开，避免「展开后的值又被当成相对路径再锚一次」。
	// 相对路径锚在用户 home 而不是宿主 cwd：cwd 随打开的工程变化，同一个设置
	// 会在不同时刻指向不同文件（与 CliSpecResolver 的取舍一致）。
	// `~user` 不支持（与 IDEA 一致）。
	let candidate: string;
	if (cleaned === '~') {
		candidate = p.home;
	} else if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
		candidate = join(p.home, cleaned.slice(2));
	} else if (isAbsoluteLike(cleaned, p.platform)) {
		candidate = cleaned;
	} else {
		candidate = join(p.home, cleaned);
	}

	if (isWslPath(candidate, p.platform)) {
		return candidate;
	}
	if (p.isFile(candidate)) {
		return candidate;
	}

	// Windows npm 全局安装只有 `.cmd` shim，用户往往不带扩展名地粘贴路径。
	if (p.platform === 'win32') {
		for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
			if (p.isFile(candidate + ext)) {
				return candidate + ext;
			}
		}
	}

	return null;
}

/**
 * 目标平台下的「绝对路径」判定。
 *
 * POSIX 只认 `/`；Windows 认盘符与 UNC。这里不把单个 `\` 当绝对路径：那是
 * 根相对，含义依赖当前盘符，不能当作规范化结果保存。
 */
function isAbsoluteLike(path: string, platform: NodeJS.Platform): boolean {
	if (path.startsWith('/')) {
		return true;
	}
	if (path.startsWith('\\\\')) {
		return true;
	}
	return platform === 'win32' && /^[A-Za-z]:[\\/]/.test(path);
}

