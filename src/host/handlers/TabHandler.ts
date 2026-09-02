/**
 * TabHandler — port of cc-gui `handler/TabHandler.java`.
 *
 * `create_new_tab`（webview ChatHeader 的「新建标签页」按钮）→ TabManager 打开
 * 一个全新的原生编辑器 tab（独立会话），名称经 TabStateService 持久化。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { TabManager } from '../tabs/TabManager';

const SUPPORTED_TYPES = ['create_new_tab'];

/** JSON 文本安全转义（作为 JS 字符串字面量注入）。 */
function escapeJs(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
}

export class TabHandler extends BaseMessageHandler {
	constructor(
		context: HandlerContext,
		private readonly tabManager: TabManager,
	) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (type !== 'create_new_tab') {
			return false;
		}
		try {
			this.tabManager.openNewTab();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.callJavaScript('addErrorMessage', escapeJs(`创建新标签页失败: ${message}`));
		}
		return true;
	}
}
