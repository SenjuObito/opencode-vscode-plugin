import { HandlerContext } from '../host/router/HandlerContext';
import { SessionHandler } from '../host/handlers/SessionHandler';
import { WindowEventHandler } from '../host/handlers/WindowEventHandler';
import { PermissionHandler } from '../host/handlers/PermissionHandler';
import type { ChatWindow } from '../host/window/ChatWindow';
import type { OpenCodeDaemonBridge } from '../host/provider/OpenCodeDaemonBridge';
import type { SettingsService } from '../host/settings/SettingsService';

/**
 * Test-only bridge to the idea-shaped window dispatcher. Production wires the
 * real ChatInstance dispatcher; ChatWindow tests need the same command owners
 * without constructing a whole extension host.
 */
export function attachWindowCommands(
	chatWindow: ChatWindow,
	daemon: unknown,
): (type: string, payload: Record<string, unknown>) => boolean {
	const channel = {
		callJavaScript: () => {},
		isDisposed: () => false,
		postRaw: () => {},
		getViewCount: () => 1,
	};
	const context = new HandlerContext(channel, {} as SettingsService);
	context.setDaemon(daemon as OpenCodeDaemonBridge);
	context.setTabSessionContext(chatWindow.createTabSessionContext());
	context.setEventPublisher((type, tabId, payload, options) => chatWindow.publishTabEvent(type, tabId, payload, options));
	const handlers = [
		new SessionHandler(context),
		new WindowEventHandler(context),
		new PermissionHandler(context),
	];
	return (type, payload) => handlers.some((handler) => handler.handle(type, JSON.stringify(payload)));
}
