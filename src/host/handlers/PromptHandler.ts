/**
 * PromptHandler — port of cc-gui `handler/PromptHandler.java` (opencode subset).
 * get_prompts → `window.updatePrompts`；opencode 自定义 prompt Phase 4 接入。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['get_prompts'];

export class PromptHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (type !== 'get_prompts') {
			return false;
		}
		let scope = 'global';
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			if (typeof json?.scope === 'string') {
				scope = json.scope;
			}
		} catch {
			// 默认 global
		}
		this.callJavaScript('updatePrompts', JSON.stringify({ provider: 'opencode', scope, prompts: [] }));
		return true;
	}
}
