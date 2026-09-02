/**
 * ModelProviderHandler — port of cc-gui `handler/provider/ModelProviderHandler.java`
 * (opencode-only subset). Handles model / provider selection from the webview.
 *
 *   set_model    → 写入 HandlerContext + SessionState，回推 onModelConfirmed
 *   set_provider → 写入 HandlerContext（SessionState.provider 固定 'opencode'）
 *
 * cc-gui 语义保留：
 *   - resolveCurrentSessionModel：session 状态优先于 context（恢复的会话可能已带模型）
 *   - isActualModelSwitch / isActualProviderSwitch：空值初始化与重复确认是 no-op，
 *     防止前端每次发消息前的重发触发副作用。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['set_model', 'set_provider'];

export class ModelProviderHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'set_model':
				this.handleSetModel(content);
				return true;
			case 'set_provider':
				this.handleSetProvider(content);
				return true;
			default:
				return false;
		}
	}

	// ── set_model ──────────────────────────────────────────────────────────

	handleSetModel(content: string): void {
		let model = content ?? '';
		if (model !== '') {
			try {
				const json = JSON.parse(model) as Record<string, unknown>;
				if (typeof json?.model === 'string') {
					model = json.model;
				}
			} catch {
				// content 本身即 model
			}
		}

		const previousModel = resolveCurrentSessionModel(this.context);
		const modelChanged = isActualModelSwitch(previousModel, model);
		console.log(`[ModelProviderHandler] set_model: ${model} (was: ${previousModel})`);

		this.context.setCurrentModel(model);
		const session = this.context.getSession();
		if (session) {
			session.state.setModel(model);
		}
		// workspaceState 持久化由 webview 侧 useModelStatePersistence 处理
		this.callJavaScript('onModelConfirmed', model, this.context.getCurrentProvider());
	}

	// ── set_provider ───────────────────────────────────────────────────────

	handleSetProvider(content: string): void {
		let provider = content ?? '';
		if (provider !== '') {
			try {
				const json = JSON.parse(provider) as Record<string, unknown>;
				if (typeof json?.provider === 'string') {
					provider = json.provider;
				}
			} catch {
				// content 本身即 provider
			}
		}

		const previousProvider = this.context.getCurrentProvider();
		const providerChanged = isActualProviderSwitch(previousProvider, provider);
		console.log(
			`[ModelProviderHandler] set_provider: ${provider} (was: ${previousProvider}, changed: ${providerChanged})`,
		);

		// opencode-only：SessionState.provider 为只读 'opencode'（发送路由固定走
		// opencode daemon），provider 仅记录在 HandlerContext 层供回推确认使用。
		this.context.setCurrentProvider(provider || previousProvider);
	}
}

/** session 状态优先于 context 的权威模型解析（cc-gui 同名方法移植）。 */
export function resolveCurrentSessionModel(context: HandlerContext): string | null {
	const sessionModel = context.getSession()?.state.getModel();
	if (sessionModel != null && sessionModel.trim() !== '') {
		return sessionModel;
	}
	return context.getCurrentModel();
}

/** 是否为真实模型切换：空值/同值均为 no-op。 */
export function isActualModelSwitch(previousModel: string | null, newModel: string): boolean {
	return (
		previousModel != null &&
		newModel != null &&
		previousModel.trim() !== '' &&
		newModel.trim() !== '' &&
		previousModel !== newModel
	);
}

/** 是否为真实 provider 切换：空值/同值均为 no-op。 */
export function isActualProviderSwitch(previousProvider: string, newProvider: string): boolean {
	return (
		previousProvider != null &&
		newProvider != null &&
		previousProvider.trim() !== '' &&
		newProvider.trim() !== '' &&
		previousProvider !== newProvider
	);
}
