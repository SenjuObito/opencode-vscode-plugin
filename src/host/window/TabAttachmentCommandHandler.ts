/**
 * TabAttachmentCommandHandler — `attachment.prepare / chunk / complete / abort`。
 *
 * webview 在发送前把附件按块推给宿主（`utils/attachmentTransport.ts`），
 * 宿主按 tab 落盘；`session.send` 只带 attachmentId，字节由宿主读出来内联给会话层。
 *
 * 失败一律回 `addErrorMessage`（投影 sink 对它是白名单，后台 tab 的失败也能看到），
 * 因为 webview 侧的分块是 fire-and-forget，没有回调可等。
 */
import { TabCommand } from '../tab/TabCommand';
import { TabRecord } from '../tab/TabRecord';
import type { TabAttachmentStore, AttachmentFailure } from '../attachments/TabAttachmentStore';
import { PluginFileLogger } from '../util/PluginFileLogger';

export interface TabAttachmentCommandHandlerOptions {
	store: () => TabAttachmentStore;
	reportError: (record: TabRecord, message: string) => void;
}

export class TabAttachmentCommandHandler {
	constructor(private readonly options: TabAttachmentCommandHandlerOptions) {}

	prepare(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		const failure = this.options.store().prepare(record.getTabId().value, {
			attachmentId: command.string('attachmentId') ?? '',
			fileName: command.string('fileName') ?? '',
			mediaType: command.string('mediaType') ?? '',
			size: command.number('size') ?? -1,
		});
		this.report(record, failure);
	}

	chunk(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		const failure = this.options.store().chunk(
			record.getTabId().value,
			command.string('attachmentId') ?? '',
			command.number('offset') ?? -1,
			command.string('data') ?? '',
		);
		this.report(record, failure);
	}

	complete(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		const failure = this.options.store().complete(
			record.getTabId().value,
			command.string('attachmentId') ?? '',
		);
		this.report(record, failure);
	}

	abort(command: TabCommand, record?: TabRecord): void {
		if (!record) {
			return;
		}
		this.options.store().abort(
			record.getTabId().value,
			command.string('attachmentId') ?? '',
		);
	}

	private report(record: TabRecord, failure: AttachmentFailure | null): void {
		if (!failure) {
			return;
		}
		PluginFileLogger.warn(
			'TabAttachmentCommandHandler',
			`tab=${record.getTabId().value} attachment=${failure.attachmentId} ${failure.reason}`,
		);
		this.options.reportError(record, `附件上传失败：${failure.reason}`);
	}
}
