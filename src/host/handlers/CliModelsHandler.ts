/**
 * CliModelsHandler — port of cc-gui `handler/CliModelsHandler.java`.
 * Lists opencode models via the persistent daemon (`opencode.getModels`)
 * instead of spawning a per-request channel-manager process.
 *
 * Frontend: `sendToJava('get_cli_models:opencode')` →
 * `window.setCliModels({ provider, models, ... })`.
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['get_cli_models'];

export class CliModelsHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		if (type !== 'get_cli_models') {
			return false;
		}
		const provider = (content ?? '').trim().toLowerCase();
		if (provider !== 'opencode') {
			this.pushError(provider, `Unsupported CLI provider for model list: ${provider}`);
			return true;
		}
		void this.listModels(provider, true);
		return true;
	}

	/**
	 * 预热缓存：只把结果写进 globalState，不推给 webview（激活阶段 webview
	 * 往往还没注册 setCliModels 回调）。
	 *
	 * 模型目录要等 daemon 起来 → `opencode serve` 拉起 → `config.providers()`
	 * 往返，第一次打开面板时串行等这一整套就是用户感知到的「模型列表加载很慢」。
	 * 预热把它挪到激活阶段完成。
	 */
	async warmCache(): Promise<void> {
		await this.listModels('opencode', false);
	}

	/**
	 * @param pushToWebview 是否把结果推给前端。true 时**先回缓存**（UI 立刻有
	 *   内容可渲染），再后台刷新一次；false 只用于预热。
	 */
	private async listModels(provider: string, pushToWebview: boolean): Promise<void> {
		const settings = this.context.getSettingsService();
		if (pushToWebview) {
			const cached = settings.getCachedCliModels();
			if (cached) {
				this.callJavaScript('setCliModels', JSON.stringify(cached));
			}
		}

		const daemon = this.context.getDaemon();
		if (!daemon) {
			if (pushToWebview) {
				this.pushError(provider, 'Daemon not ready');
			}
			return;
		}

		const chunks: string[] = [];
		const ok = await daemon.request('opencode.getModels', {}, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				if (pushToWebview) {
					this.pushError(provider, error);
				}
			},
			onComplete: (success) => {
				if (!success) {
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				if (!payload) {
					if (pushToWebview) {
						this.pushError(provider, 'No model list JSON in opencode.getModels output');
					}
					return;
				}
				if (typeof payload.provider !== 'string' || payload.provider === '') {
					payload.provider = provider;
				}
				settings.setCachedCliModels(payload);
				if (pushToWebview) {
					this.callJavaScript('setCliModels', JSON.stringify(payload));
				}
			},
		});
		if (!ok && pushToWebview) {
			this.pushError(provider, 'Daemon unavailable for model list');
		}
	}

	/** 从 daemon 输出的原始缓冲区提取 JSON 对象（容错非 JSON 诊断行）。 */
	private extractJsonObject(raw: string): Record<string, unknown> | null {
		if (!raw || raw.trim() === '') {
			return null;
		}
		const lines = raw.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line.startsWith('{') || !line.endsWith('}')) {
				continue;
			}
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj && (obj.models !== undefined || obj.success !== undefined)) {
					return obj;
				}
			} catch {
				// 跳过
			}
		}
		try {
			const start = raw.lastIndexOf('{');
			const end = raw.lastIndexOf('}');
			if (start >= 0 && end > start) {
				return JSON.parse(raw.substring(start, end + 1)) as Record<string, unknown>;
			}
		} catch {
			// 忽略
		}
		return null;
	}

	private pushError(provider: string, message: string): void {
		this.callJavaScript(
			'setCliModels',
			JSON.stringify({
				success: false,
				provider: provider ?? '',
				error: message ?? 'unknown error',
				models: [],
			}),
		);
	}
}
