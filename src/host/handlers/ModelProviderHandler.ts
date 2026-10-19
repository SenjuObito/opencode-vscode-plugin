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
import type { OpenCodeSession } from '../session/OpenCodeSession';

const SUPPORTED_TYPES = ['set_model', 'set_provider'];

interface ModelSelectionPayload {
	model: string;
	sessionId?: string;
	/** 切 tab 时的状态回放，不是用户主动切换模型。 */
	silent: boolean;
}

/**
 * 解析 `set_model` 的 payload。
 *
 * 新格式 `{model, sessionId, silent}`；旧版前端发裸模型字符串，按窗口级处理。
 * `sessionId` 让宿主写到调用方 tab 自己的会话，而不是「窗口当前会话」——
 * 两者在切 tab 后就会分叉，写错会静默改掉另一个对话的模型。
 */
function parseModelPayload(content: string): ModelSelectionPayload {
	const raw = content ?? '';
	const trimmed = raw.trim();
	if (trimmed === '' || !trimmed.startsWith('{')) {
		return { model: raw, silent: false };
	}
	try {
		const json = JSON.parse(trimmed) as Record<string, unknown>;
		return {
			model: typeof json.model === 'string' ? json.model : raw,
			sessionId: typeof json.sessionId === 'string' && json.sessionId.trim() !== ''
				? json.sessionId.trim()
				: undefined,
			silent: json.silent === true,
		};
	} catch {
		// content 本身即 model
		return { model: raw, silent: false };
	}
}

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
		const payload = parseModelPayload(content);
		const model = payload.model;

		// 按 sessionId 路由到调用方 tab 自己的会话。找不到时按 tabId 补建
		// （新 tab 在第一次发送前还没有宿主会话），最后才回退到窗口当前会话。
		const target = this.resolveTargetSession(payload.sessionId);
		const previousModel = target?.state.getModel() ?? this.context.getCurrentModel();
		const modelChanged = isActualModelSwitch(previousModel, model);
		console.log(
			`[ModelProviderHandler] set_model: ${model} (was: ${previousModel})`
			+ (payload.silent ? ' [silent restore]' : '')
			+ (payload.sessionId ? ` [session=${payload.sessionId}]` : ''),
		);

		// 窗口级模型仍然更新：它是新建会话 / 无 sessionId 请求的默认值。
		this.context.setCurrentModel(model);
		if (target) {
			target.state.setModel(model);
		}
		// workspaceState 持久化由 webview 侧 useModelStatePersistence 处理
		this.callJavaScript('onModelConfirmed', model, this.context.getCurrentProvider());

		// 上下文额度是模型自身的属性：不重推的话用量环会停在旧模型的分母上
		// （1M 的模型切过去仍显示 200k），直到下一轮 usage 事件才纠正。
		// 必须在 setModel 之后执行，否则解析到的还是旧额度。
		//
		// silent = 切 tab 时的状态回放，不是用户真的换了模型：此时重推会在会话
		// 没有历史用量时把用量环清空，来回切 tab 就能把数字刷掉（idea 同款处理）。
		if (modelChanged && target && !payload.silent) {
			target.republishUsageAfterModelChange();
		}
	}

	/** 按 sessionId 取目标会话；未知 id 先按 tabId 补建，最后回退到当前会话。 */
	private resolveTargetSession(sessionId: string | undefined): OpenCodeSession | null {
		const id = sessionId?.trim();
		if (!id) {
			return this.context.getSession();
		}
		const scoped = this.context.getSession(id);
		if (scoped) {
			return scoped;
		}
		const created = this.context.getSessionManager()?.ensureSessionForTab(id) ?? null;
		if (created) {
			return created;
		}
		console.warn(`[ModelProviderHandler] Unknown sessionId ${id} — falling back to current session`);
		return this.context.getSession();
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
