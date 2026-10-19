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
import { updateModelContextWindows } from '../util/ModelContextWindowCatalog';

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
		void this.listModels(provider);
		return true;
	}

	private async listModels(provider: string): Promise<void> {
		// Cache-first: serve 是唯一数据源，但 daemon/serve 冷启动要往返一次，
		// 这期间先渲染上一次成功拉取的清单（idea 插件的同款行为），避免
		// "模型列表为空 → 推理档位未知"的窗口。
		const cached = this.readCachedPayload(provider);
		if (cached) {
			this.primeCatalog(cached);
			this.callJavaScript('setCliModels', JSON.stringify(cached));
		}

		const daemon = this.context.getDaemon();
		if (!daemon) {
			if (!cached) {
				this.pushError(provider, 'Daemon not ready');
			}
			return;
		}

		const chunks: string[] = [];
		const ok = await daemon.request('opencode.getModels', {}, {
			onLine: (line) => chunks.push(line),
			onError: (error) => {
				// 已有缓存时保持静默：前端已经有可用清单，不必显示错误态。
				if (!cached) {
					this.pushError(provider, error);
				}
			},
			onComplete: (success) => {
				if (!success) {
					if (!cached) {
						this.pushError(provider, 'Failed to list models');
					}
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				if (!payload) {
					if (!cached) {
						this.pushError(provider, 'No model list JSON in opencode.getModels output');
					}
					return;
				}
				if (typeof payload.provider !== 'string' || payload.provider === '') {
					payload.provider = provider;
				}
				// Teach the context-window catalog before the webview sees the list,
				// so the very next usage push resolves the real model limit.
				this.primeCatalog(payload);
				const json = JSON.stringify(payload);
				this.context.getSettingsService().setCliModelsCache(provider, json);
				this.callJavaScript('setCliModels', json);
			},
		});
		if (!ok && !cached) {
			this.pushError(provider, 'Daemon unavailable for model list');
		}
	}

	/**
	 * Read the last successful payload from the workspace cache.
	 * Returns a parsed object only when it still looks usable — a stale entry
	 * must never resurrect an empty list or an error payload.
	 */
	private readCachedPayload(provider: string): Record<string, unknown> | null {
		try {
			const raw = this.context.getSettingsService().getCliModelsCache(provider);
			if (!raw) {
				return null;
			}
			const payload = JSON.parse(raw) as Record<string, unknown>;
			if (!payload || payload.success === false) {
				return null;
			}
			if (!Array.isArray(payload.models) || payload.models.length === 0) {
				return null;
			}
			if (typeof payload.provider !== 'string' || payload.provider === '') {
				payload.provider = provider;
			}
			return payload;
		} catch {
			return null;
		}
	}

	/**
	 * Merge the payload's per-model context windows and, when the catalog learned
	 * something new, re-publish the usage snapshot that may have been computed
	 * against the cold 200k fallback. A session with no usage snapshot pushes
	 * nothing, so a warmup before the first turn stays silent.
	 */
	private primeCatalog(payload: unknown): void {
		try {
			if (!updateModelContextWindows(payload)) {
				return;
			}
			this.context.getSession()?.republishUsageFromHistory();
		} catch (error) {
			console.warn('[CliModels] Usage republish skipped:', error);
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
