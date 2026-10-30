/**
 * WindowEventHandler — port of cc-gui `handler/WindowEventHandler.java`.
 * Handles window-level events: heartbeat, frontend_ready, history_dom_committed.
 *
 * 斜杠命令刷新由本处理器接收 v2 `commands.refresh`；会话发送由
 * `SessionHandler` 按 payload 的 tabId/sessionId 处理。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { logDiagnostic, logDiagnosticBlock } from '../util/DiagnosticLogger';
import { ListMessagesCollector } from '../util/ListMessagesCollector';
import { pushHistoryData, upsertSessionSummary } from '../session/SessionHistoryStore';
import { pushUserLanguageConfig, pushUiPreferences, pushPinnedModels } from './SettingsHandler';
import { updateModelContextWindows } from '../util/ModelContextWindowCatalog';
import { extractJsonObject, listSlashCommands } from '../util/SlashCommandCatalog';
import { OpenCodeDaemonBridge } from '../provider/OpenCodeDaemonBridge';


const SUPPORTED_TYPES = [
	'heartbeat',
	'tab_loading_changed',
	'tab_status_changed',
	'frontend_ready',
	'history_dom_committed',
	'history_render_complete',
	'refresh_file',
	'get_active_provider',
	'get_thinking_enabled',
	'check_daemon_status',
	'open_external_url',
	'copy_to_clipboard',
	'commands.refresh',
	'context.refresh',
];

export class WindowEventHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'heartbeat':
				// 心跳由 daemon 生命周期管理；这里仅确认存活
				return true;
			case 'frontend_ready':
				this.handleFrontendReady();
				return true;
			case 'get_active_provider':
				this.handleGetActiveProvider();
				return true;
			case 'commands.refresh':
				this.handleRefreshSlashCommands(this.payloadString(content, 'tabId'));
				return true;
			case 'context.refresh':
				this.handleTabContextRefresh(content);
				return true;
			case 'get_thinking_enabled':
				// opencode 无 thinking 开关；回默认关闭
				this.callJavaScript('updateThinkingEnabled', JSON.stringify({ enabled: false }));
				return true;
			case 'check_daemon_status':
				// 用户在「OpenCode serve 未运行」提示上点重试：重新拉起并探测等待 serve 就绪。
				void this.handleCheckDaemonStatus();
				return true;
			case 'open_external_url':
				this.handleOpenExternalUrl(content);
				return true;
			case 'copy_to_clipboard':
				this.handleCopyToClipboard(content);
				return true;
			case 'history_dom_committed':
			case 'history_render_complete':
			case 'tab_loading_changed':
			case 'tab_status_changed':
			case 'refresh_file':
				// 前端渲染确认或文件刷新通知，无后端副作用
				return true;
			default:
				return false;
		}
	}

	/** frontend_ready：回放会话状态 / provider / mode / 依赖 / slash 命令 / linkify。 */
	private handleFrontendReady(): void {
		const session = this.context.getSession();
		if (!session) {
			return;
		}

		// ── 方案 B：视图就绪时先对齐宿主内存与这个刚出现的空视图 ──
		// 每个 webview 只在启动时发一次 frontend_ready，收到它就意味着「来了一个
		// 空视图」。若宿主持有的是上一会话的残留，就会表现为「打开是空对话、
		// 一发消息旧对话诈尸」。必须在回放状态之前清理，否则下面的 sessionId
		// 回放会把旧会话 id 塞给空视图，后续 send 再次命中旧会话。
		const startedFresh = session.reconcileWithFreshView();

		this.callJavaScript(
			'applyBackendTabState',
			JSON.stringify({
				provider: 'opencode',
				model: session.state.getModel() ?? '',
				permissionMode: session.state.getPermissionMode(),
				reasoningEffort: session.state.getReasoningEffort(),
			}),
		);

		this.pushActiveProvider();

		this.callJavaScript('onModeReceived', session.state.getPermissionMode());

		// sessionId 只在宿主**仍持有该会话**时回放（多视图共享同一会话的情形）。
		// 单视图时 reconcileWithFreshView 已把状态清成新会话，此时若仍把旧 id 推给
		// 空视图，用户下一次发送就会带着旧 id 打到旧会话上，旧消息被整份带回。
		const sessionId = session.state.getSessionId();
		if (!startedFresh && sessionId) {
			this.callJavaScript('setSessionId', sessionId);
		}

		this.handleRefreshSlashCommands(null);
		void this.sendDaemonStatus();
		this.sendLinkifyCapabilities();

		// 语言回放：手动设置过 → source 'user'；否则跟随 IDE 界面语言。
		// webview 的 applyIdeaLanguageConfig 会 changeLanguage 并写 localStorage。
		pushUserLanguageConfig((fn, ...args) => this.callJavaScript(fn, ...args), this.context.getSettingsService());

		// UI 偏好回放（主题 / 字号 / 配色 / diff / 行为开关）：webview 的
		// localStorage 在 VS Code 重建 webview 后会丢，宿主才是权威源。
		pushUiPreferences((fn, ...args) => this.callJavaScript(fn, ...args), this.context.getSettingsService());

		// 置顶模型回放（跨会话持久化）
		pushPinnedModels((fn, ...args) => this.callJavaScript(fn, ...args), this.context.getSettingsService());

		// 字体配置回放（编辑器字体、已保存的 UI 字体与代码字体）
		this.context.pushFontConfig();

		// 推送当前编辑器上下文（需在 webview JS 就绪后调用）。
		this.context.pushEditorContext();
	}

	/** bootstrap 的 get_active_provider：回推 opencode provider 配置。 */
	private handleGetActiveProvider(): void {
		this.pushActiveProvider();
	}

	private pushActiveProvider(): void {
		this.callJavaScript(
			'updateActiveProvider',
			JSON.stringify({
				provider: 'opencode',
				id: 'opencode',
				name: 'OpenCode',
				type: 'opencode',
			}),
		);
	}

	/**
	 * 窗口级斜杠命令回放（frontend_ready）。
	 * 请求与解析统一走 `SlashCommandCatalog`；tab 级刷新见 `commands.refresh`。
	 */
	private handleRefreshSlashCommands(tabId?: string | null): void {
		const directory = tabId ? this.context.getCwdForTab(tabId) : null;
		listSlashCommands(this.context.getDaemon(), directory, (commands) => {
			if (tabId && this.context.publishTabEvent('slash.commands', tabId, { commands })) {
				return;
			}
			this.pushSlashCommands(commands);
		});
	}

	private pushSlashCommands(commands: Array<{ name: string; description?: string; source?: string }>): void {
		this.callJavaScript('updateSlashCommands', JSON.stringify(commands));
	}

	private handleTabContextRefresh(content: string): void {
		const tabId = this.payloadString(content, 'tabId');
		if (!tabId) {
			return;
		}
		let enabled = true;
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			enabled = parsed.enabled !== false;
		} catch {
			// Keep the default-on behaviour for a malformed/legacy payload.
		}
		this.context.setTabContextEnabled(tabId, enabled);
	}

	private payloadString(content: string, key: string): string | null {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const value = parsed?.[key];
			return typeof value === 'string' && value.length > 0 ? value : null;
		} catch {
			return null;
		}
	}

	/**
	 * webview 内 window.open / <a target=_blank> 被 VS Code 拦截，改由宿主 openExternal。
	 *
	 * 协议白名单与 webview 侧的 `SAFE_BROWSER_PROTOCOLS` 一致：http/https/mailto。
	 * `file:` 与 `javascript:` 必须挡住 —— 前者能读本机文件，后者能在宿主上下文执行。
	 */
	private handleOpenExternalUrl(content: string): void {
		const url = (content ?? '').trim();
		if (!/^(https?:\/\/|mailto:)/i.test(url)) {
			return;
		}
		this.context.getFileOps().openExternal(url);
	}

	/**
	 * webview 内 navigator.clipboard / execCommand 受权限策略限制不可靠，
	 * 关键复制（分享链接等）改走宿主 vscode.env.clipboard。完成后回推结果。
	 */
	private handleCopyToClipboard(content: string): void {
		const text = content ?? '';
		let ok = false;
		try {
			ok = text.length > 0 && this.context.getFileOps().copyToClipboard(text);
		} catch (err) {
			console.error('[WindowEventHandler] copy_to_clipboard failed:', err);
		}
		this.callJavaScript('onCopyToClipboardResult', ok ? 'true' : 'false');
	}

	private sendDaemonStatusInFlight = false;

	private async handleCheckDaemonStatus(): Promise<void> {
		const daemon = this.context.getDaemon();
		if (daemon && !daemon.isAlive() && !daemon.isStarting()) {
			await daemon.start();
		}
		await this.sendDaemonStatus();
	}

	/**
	 * 向 webview 推送 daemon / serve / models 就绪状态。
	 *
	 * 关键点：状态栏（"正在检查 opencode serve 状态..."）必须等到：
	 * 1. opencode serve 进程成功启动且连通；
	 * 2. 模型列表成功从 opencode serve 获取并推送给 webview；
	 * 两个阶段均完成之后，才发 { alive: true, serveReady: true } 让状态栏消失。
	 *
	 * 若任一阶段失败（如 CLI 缺失、serve 退出、模型列表为空/报错）：
	 * 立即推送 { alive: false, serveReady: false } 切到「未运行」可重试态，展示失败与重试按钮。
	 */
	private async sendDaemonStatus(): Promise<void> {
		if (this.sendDaemonStatusInFlight) {
			return;
		}
		this.sendDaemonStatusInFlight = true;

		try {
			const daemon = this.context.getDaemon();
			if (!daemon) {
				this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false }));
				return;
			}

			// 1. 先发 loading 态，让状态栏保持转圈显示「正在检查...」
			this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: true, serveReady: false, engine: daemon.getEngineStatus() }));

			// 若 daemon 正在启动中或尚未存活，等待启动完成
			if (daemon.isStarting() || !daemon.isAlive()) {
				const started = await daemon.start();
				if (!started || !daemon.isAlive()) {
					this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false, engine: daemon.getEngineStatus() }));
					return;
				}
			}

			// 2. 阶段一：异步等待 serve 就绪（opencode.preconnect）
			const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
			const preconnectOk = await new Promise<boolean>((resolve) => {
				daemon.request(
					'opencode.preconnect',
					{ cwd: directory },
					{
						onLine: () => {},
						onError: () => resolve(false),
						onComplete: (success: boolean) => resolve(success),
					},
				);
			});

			if (!preconnectOk) {
				// serve 启动失败或异常退出：落到「未运行」可重试态
				this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false, engine: daemon.getEngineStatus() }));
				return;
			}

			// 3. 阶段二：获取模型列表并校验
			const modelsOk = await this.fetchAndPushModels(daemon, 'opencode');
			if (modelsOk) {
				// serve 真正就绪 且 模型列表成功获取分发：发最终信号让状态栏消失
				this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: true, serveReady: true, engine: daemon.getEngineStatus() }));
			} else {
				// 模型列表获取失败：落到「未运行」可重试态
				this.callJavaScript('updateDaemonStatus', JSON.stringify({ alive: false, serveReady: false, engine: daemon.getEngineStatus() }));
			}
		} finally {
			this.sendDaemonStatusInFlight = false;
		}
	}

	/** 获取模型列表并同步推送到 webview 与上下文窗口目录 */
	private async fetchAndPushModels(daemon: OpenCodeDaemonBridge, provider: string): Promise<boolean> {
		const chunks: string[] = [];
		return new Promise<boolean>((resolve) => {
			daemon.request('opencode.getModels', {}, {
				onLine: (line) => chunks.push(line),
				onError: (error) => {
					this.pushModelError(provider, error);
					resolve(false);
				},
				onComplete: (success) => {
					if (!success) {
						resolve(false);
						return;
					}
					const payload = extractJsonObject(chunks.join('\n'));
					if (!payload || payload.success === false) {
						const err = (typeof payload?.error === 'string' && payload.error)
							? payload.error
							: 'No model list returned';
						this.pushModelError(provider, err);
						resolve(false);
						return;
					}
					if (typeof payload.provider !== 'string' || payload.provider === '') {
						payload.provider = provider;
					}
					try {
						updateModelContextWindows(payload);
						this.context.getSession()?.republishUsageFromHistory();
					} catch (e) {
						// ignore catalog update error
					}
					this.callJavaScript('setCliModels', JSON.stringify(payload));
					const models = Array.isArray(payload.models) ? payload.models : [];
					resolve(models.length > 0);
				},
			});
		});
	}

	private pushModelError(provider: string, message: string): void {
		this.callJavaScript(
			'setCliModels',
			JSON.stringify({
				success: false,
				provider: provider ?? 'opencode',
				error: message ?? 'unknown error',
				models: [],
			}),
		);
	}



	private sendLinkifyCapabilities(): void {
		this.callJavaScript(
			'updateLinkifyCapabilities',
			JSON.stringify({ classNavigationEnabled: false, linkifyCapabilities: { file: true, line: true, url: true } }),
		);
	}
}
