/**
 * CliStatusHandler — answers the webview's `get_cli_status:` request
 * (Settings → Provider Management → 本地 CLI 工具检测).
 * Detects the local `opencode` CLI and reports to `window.updateCliStatus`
 * as `{ opencode: { id, name, binaryName, installed, version?, path? } }`.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { findOpenCodeCli } from '../util/OpenCodeCliLocator';

const SUPPORTED_TYPES = ['get_cli_status'];

export class CliStatusHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (!this.matchesType(type, ...SUPPORTED_TYPES)) {
			return false;
		}
		const cli = findOpenCodeCli();
		this.callJavaScript(
			'updateCliStatus',
			JSON.stringify({
				opencode: {
					id: 'opencode',
					name: 'OpenCode CLI',
					binaryName: 'opencode',
					installed: cli !== null,
					version: cli?.version,
					path: cli?.path,
				},
			}),
		);
		return true;
	}
}
