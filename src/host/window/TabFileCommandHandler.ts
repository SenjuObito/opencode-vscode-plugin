import { PluginFileLogger } from '../util/PluginFileLogger';
import type { FileEntry } from '../handlers/FileHandler';
import type { TabCommand } from '../tab/TabCommand';
import type { TabRecord } from '../tab/TabRecord';

export interface TabFileCommandHandlerOptions {
	/** 列举候选文件（daemon findFiles 优先，失败回退本地扫描）。 */
	listFiles: (query: string, directory: string | undefined) => Promise<FileEntry[]>;
	/** 把结果作为 `files.listed` 事件推给目标 tab。 */
	publish: (tabId: string, epoch: number, payload: Record<string, unknown>) => void;
}

/**
 * `files.list` —— @ 文件补全候选（§10.11）。
 *
 * 与 legacy `list_files` 的差别只有两处，但都是必须的：
 *  1. 结果走 **v2 事件**（`files.listed`）回到目标 tab，而不是窗口级回调 ——
 *     多个视图/多 tab 时，候选必须回到发起请求的那个 tab；
 *  2. 列举用的目录是**目标 tab 的 cwd**，不是窗口级的设置目录。
 *
 * `requestId` 原样带回：前端用它把乱序返回对齐到各自的请求。
 */
export class TabFileCommandHandler {
	private readonly options: TabFileCommandHandlerOptions;

	constructor(options: TabFileCommandHandlerOptions) {
		this.options = options;
	}

	async list(command: TabCommand, record?: TabRecord): Promise<void> {
		if (!record) {
			return;
		}
		const query = command.string('query') ?? '';
		const requestId = command.number('requestId');
		const cwd = record.getCwd() || undefined;

		let files: FileEntry[] = [];
		try {
			files = await this.options.listFiles(query, cwd);
		} catch (err) {
			PluginFileLogger.warn('TabFileCommandHandler', `files.list failed: ${String(err)}`);
			files = [];
		}

		// 必须始终回包：否则前端会挂到 5s 超时才清 loading。
		const payload = requestId != null ? { files, requestId } : { files };
		this.options.publish(record.getTabId().value, record.epoch, {
			data: JSON.stringify(payload),
		});
	}
}
