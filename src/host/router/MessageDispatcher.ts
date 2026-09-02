/**
 * MessageDispatcher — port of cc-gui `handler/core/MessageDispatcher.java`.
 * Routes `type:content` messages to the first matching handler.
 */
import { MessageHandler } from './MessageHandler';

export class MessageDispatcher {
	private readonly handlers: MessageHandler[] = [];

	registerHandler(handler: MessageHandler): void {
		this.handlers.push(handler);
	}

	/** 按注册顺序分发，命中即停。 */
	dispatch(type: string, content: string): boolean {
		for (const handler of this.handlers) {
			if (handler.handle(type, content)) {
				return true;
			}
		}
		console.error(`[Dispatcher] NO handler matched type=${type}`);
		return false;
	}

	hasHandlerFor(type: string): boolean {
		return this.handlers.some((handler) => handler.getSupportedTypes().includes(type));
	}

	getHandlerCount(): number {
		return this.handlers.length;
	}

	clear(): void {
		this.handlers.length = 0;
	}
}
