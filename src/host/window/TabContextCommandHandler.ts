/**
 * TabContextCommandHandler — tab 级「上下文」与「斜杠命令」命令。
 *
 * 这两个命令在 webview 侧早已按 tab 发送（`sendHostCommand(tabId, …)`），
 * 但宿主此前没有接收方，`ChatWindow.handleViewCommand` 一律回 `UNKNOWN_TYPE`，
 * 属于断链。本模块补上接收端：
 *
 *   - `context.refresh`  `{ enabled }`  写目标 tab 的 `TabSettings`
 *                                       （autoOpenFileEnabled / contextEnabled），
 *                                       下次发送按该 tab 的开关决定是否注入编辑器上下文。
 *   - `commands.refresh` `{}`           按目标 tab 的 cwd 列举 opencode 斜杠命令，
 *                                       回推 `updateSlashCommands`。
 *
 * 斜杠命令列表**按 tab**：命令是按目录发现的（自定义命令 / skill），不同 cwd 的
 * tab 看到的列表不同。结果作为语义事件 `slash.commands` 投回**目标 tab**；
 * 没有 tab 身份时（窗口级 `frontend_ready` 回放）才广播。
 */
import { TabCommand } from '../tab/TabCommand';
import { TabRecord } from '../tab/TabRecord';
import type { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';
import { listSlashCommands } from '../util/SlashCommandCatalog';
import { WebviewBroadcaster } from '../router/WebviewBroadcaster';
import { PluginFileLogger } from '../util/PluginFileLogger';

export class TabContextCommandHandler {
	constructor(
		private readonly daemon: () => OpenCodeDaemonBridge | null,
		/** 按 tab 投递语义事件（`slash.commands`）。 */
		private readonly publish?: (
			type: string,
			tabId: string,
			payload: Record<string, unknown>,
		) => void,
	) {}

	/**
	 * 设置目标 tab 的上下文注入开关。
	 *
	 * `enabled` 缺失时按「开启」处理：webview 只在切换开关时发送本命令，
	 * 缺字段只可能来自旧版 webview，此时保持与默认值一致的行为。
	 */
	refreshContext(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		const enabled = command.boolean('enabled') ?? true;
		record.getSettings().setAutoOpenFileEnabled(enabled);
		record.getSettings().setContextEnabled(enabled);
		PluginFileLogger.info(
			'TabContextCommandHandler',
			`context.refresh tab=${command.tabId.value} enabled=${enabled}`,
		);
	}

	/** 按目标 tab 的 cwd 列举斜杠命令，并投回那个 tab。 */
	refreshCommands(command: TabCommand, record?: TabRecord): void {
		const directory = record && record.getCwd() ? record.getCwd() : null;
		const tabId = record ? record.getTabId().value : null;
		listSlashCommands(this.daemon(), directory, (commands) => {
			if (tabId && this.publish) {
				// 命名事件：webview 侧按 envelope.tabId 归到对应 tab 的缓存。
				this.publish('slash.commands', tabId, { commands });
				return;
			}
			// 没有 tab 身份（窗口级回放）才广播。
			WebviewBroadcaster.broadcastJavaScript('updateSlashCommands', JSON.stringify(commands));
		});
		PluginFileLogger.info(
			'TabContextCommandHandler',
			`commands.refresh tab=${command.tabId.value} cwd=${directory ?? '<serve default>'}`,
		);
	}
}
