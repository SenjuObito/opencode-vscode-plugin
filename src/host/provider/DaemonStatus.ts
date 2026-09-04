/**
 * DaemonStatus.ts
 *
 * `updateDaemonStatus` 事件的宿主侧协议定义与失败分类。
 *
 * 早期协议只有 `{alive, serveReady}`，webview 只能区分「加载中」和「未运行」，
 * 一旦 opencode serve 拉不起来（最常见：opencode 根本没装），状态栏就从转圈
 * 变成一句无信息量的「OpenCode serve 未运行」，用户不知道该装什么、为什么失败。
 *
 * 现在补充：
 * - `phase`：starting（正在拉起，保持转圈）/ ready（就绪，收起提示）/ failed（失败，展示原因）；
 * - `code` + `detail`：失败分类与原始原因，webview 按 code 取对应文案；
 * - `installCmd`：opencode 未安装时给出的平台安装命令。
 *
 * `phase` 缺省时 webview 走旧协议的兜底逻辑，保证前后端版本错配时不会卡死。
 */

/** daemon / serve 状态阶段。 */
export type DaemonStatusPhase = 'starting' | 'ready' | 'failed';

export interface DaemonStatusPayload {
	alive: boolean;
	serveReady: boolean;
	/** 缺省时 webview 走旧协议兜底（见文件头说明）。 */
	phase?: DaemonStatusPhase;
	/** 面向用户的失败分类码（见 DaemonIssueCode），仅 phase='failed' 时有意义。 */
	code?: string;
	/** 失败细节（ai-bridge 的原始报错 / stderr 尾巴），可为空。 */
	detail?: string;
	/** opencode 未安装时的安装命令，webview 提供一键复制。 */
	installCmd?: string;
}

/** 面向用户的失败分类码（webview 用 `chat.daemonIssue.<code>` 取文案）。 */
export type DaemonIssueCode =
	/** 系统里找不到 opencode 可执行文件。 */
	| 'NOT_INSTALLED'
	/** opencode 在，但 serve 起不来（超时 / 端口无响应）。 */
	| 'START_TIMEOUT'
	/** opencode 在，但 serve 启动失败（意外退出 / spawn 报错）。 */
	| 'START_FAILED'
	/** 插件自带 ai-bridge 依赖缺失（ESM import 直接崩）。 */
	| 'BRIDGE_DEPS_MISSING'
	/** daemon 脚本不存在 / 无法 spawn。 */
	| 'BRIDGE_LAUNCH_FAILED'
	/** daemon 进程起来了但 30s 内没 ready。 */
	| 'BRIDGE_START_FAILED'
	/** 运行中的 daemon 意外退出。 */
	| 'DAEMON_DIED'
	/** 宿主还没装配 daemon。 */
	| 'NO_DAEMON';

/** ai-bridge 侧的错误码（ai-bridge/services/opencode/opencode-serve-manager.js）。 */
const NOT_FOUND_CODES = new Set(['OPENCODE_NOT_FOUND', 'OPENCODE_SPAWN_ENOENT']);
const TIMEOUT_CODES = new Set(['OPENCODE_SERVE_TIMEOUT', 'OPENCODE_SERVE_NOT_READY']);

/** 平台对应的 opencode 安装命令，展示给用户并可一键复制。 */
export function openCodeInstallCommand(): string {
	return process.platform === 'win32'
		? 'npm install -g opencode-ai'
		: 'curl -fsSL https://opencode.ai/install | bash';
}

/**
 * 把 ai-bridge 回传的 serve 错误码 + 原始报错翻译成面向用户的失败状态。
 *
 * 未拿到分类码时按「启动失败」处理，并把原始报错作为 detail 透出——宁可多给
 * 一行技术细节，也不要只剩一句「未运行」。
 */
export function classifyServeFailure(error?: string, code?: string): DaemonStatusPayload {
	const detail = (error ?? '').trim();
	if (code && NOT_FOUND_CODES.has(code)) {
		return {
			alive: false,
			serveReady: false,
			phase: 'failed',
			code: 'NOT_INSTALLED',
			detail,
			installCmd: openCodeInstallCommand(),
		};
	}
	if (code && TIMEOUT_CODES.has(code)) {
		return { alive: false, serveReady: false, phase: 'failed', code: 'START_TIMEOUT', detail };
	}
	return {
		alive: false,
		serveReady: false,
		phase: 'failed',
		code: 'START_FAILED',
		detail: detail || 'opencode serve 启动失败，但未返回具体原因。',
	};
}
