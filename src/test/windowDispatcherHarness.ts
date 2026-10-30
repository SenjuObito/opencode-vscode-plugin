import { HandlerContext } from '../host/router/HandlerContext';
import { MessageHandler } from '../host/router/MessageHandler';
import { SessionHandler } from '../host/handlers/SessionHandler';
import { WindowEventHandler } from '../host/handlers/WindowEventHandler';
import { PermissionHandler } from '../host/handlers/PermissionHandler';
import type { ChatWindow } from '../host/window/ChatWindow';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';
import type { SettingsService } from '../host/settings/SettingsService';

export interface WindowCommandHandlers {
	/** 与生产 `instance.dispatcher.dispatch` 同一形状。 */
	dispatch: (type: string, payload: Record<string, unknown>) => boolean;
	/** 提示答复测试需要往 handler 里预置未决 prompt。 */
	permissionHandler: PermissionHandler;
}

/**
 * Test-only bridge to the idea-shaped window dispatcher. Production wires the
 * real ChatInstance dispatcher; ChatWindow tests need the same command owners
 * without constructing a whole extension host.
 */
export function createWindowCommandHandlers(
	chatWindow: ChatWindow,
	daemon: unknown,
): WindowCommandHandlers {
	const channel = {
		callJavaScript: () => {},
		isDisposed: () => false,
		postRaw: () => {},
		getViewCount: () => 1,
	};
	const context = new HandlerContext(channel, {
		getEffectiveWorkingDirectory: () => '/mock/workspace',
		getAskUserQuestionSoundNotificationEnabled: () => false,
		getAskUserQuestionNotificationEnabled: () => false,
		getSoundNotificationEnabled: () => false,
		getTaskCompletionNotificationEnabled: () => false,
		getSoundOnlyWhenUnfocused: () => false,
		getUserLanguage: () => 'en',
	} as unknown as SettingsService);
	context.setDaemon(daemon as OpenCodeDaemonBridge);
	context.setTabSessionContext(chatWindow.createTabSessionContext());
	context.setEventPublisher((type, tabId, payload, options) => chatWindow.publishTabEvent(type, tabId, payload, options));
	const permissionHandler = new PermissionHandler(context);
	const handlers: MessageHandler[] = [
		new SessionHandler(context),
		new WindowEventHandler(context),
		permissionHandler,
	];
	return {
		dispatch: (type, payload) => handlers.some((handler) => handler.handle(type, JSON.stringify(payload))),
		permissionHandler,
	};
}

export function attachWindowCommands(
	chatWindow: ChatWindow,
	daemon: unknown,
): (type: string, payload: Record<string, unknown>) => boolean {
	return createWindowCommandHandlers(chatWindow, daemon).dispatch;
}
