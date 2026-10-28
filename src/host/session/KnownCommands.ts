/**
 * Known OpenCode slash commands —— 移植自 idea `session/KnownCommands.java`。
 *
 * 只有命中这张表的命令才会走 core 的 `/session/{id}/command` 端点；
 * 其余以 `/` 开头的文本（`/Users/...`、`/etc/...`、`/v2/...`）按普通消息处理。
 *
 * 陷阱：命令**不能**当普通 prompt 发 —— 普通消息会被注入编辑器上下文与 agent
 * 角色，而命令不该吃这些。所以这里的白名单是必须的。
 *
 * 自定义命令（用户在 `.opencode/command/` 里写的）不在表内，但服务端会把它们
 * 公布在命令列表里；`SlashCommandCatalog` 记住那份名单，二者取并集。
 */
const KNOWN_OPENCODE_COMMANDS: ReadonlySet<string> = new Set([
	'commit',
	'review',
	'init',
	'undo',
	'redo',
	'clear',
	'help',
	'test',
	'compact',
	'editor',
	'context',
	'plan',
	'resume',
	'skills',
	'mcp',
	'status',
	'exit',
	'quit',
	'doctor',
	'version',
	'config',
	'login',
	'logout',
	'export',
	'share',
	'unshare',
	'opencode',
]);

/**
 * 是否是已知的 opencode 斜杠命令（忽略大小写、不带前导 '/'）。
 */
export function isKnownSlashCommand(command: string | null | undefined): boolean {
	if (!command) {
		return false;
	}
	return KNOWN_OPENCODE_COMMANDS.has(command.trim().toLowerCase());
}
