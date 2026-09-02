/**
 * Message handler interface + base — port of cc-gui
 * `handler/core/{MessageHandler,BaseMessageHandler}.java`.
 */
import { HandlerContext } from './HandlerContext';

export interface MessageHandler {
	/** 处理一条 `type:content` 消息。返回 true 表示已处理。 */
	handle(type: string, content: string): boolean;
	getSupportedTypes(): string[];
}

export abstract class BaseMessageHandler implements MessageHandler {
	protected readonly context: HandlerContext;

	constructor(context: HandlerContext) {
		this.context = context;
	}

	protected callJavaScript(functionName: string, ...args: string[]): void {
		this.context.callJavaScript(functionName, ...args);
	}

	protected matchesType(type: string, ...supportedTypes: string[]): boolean {
		return supportedTypes.includes(type);
	}

	abstract handle(type: string, content: string): boolean;
	abstract getSupportedTypes(): string[];
}
