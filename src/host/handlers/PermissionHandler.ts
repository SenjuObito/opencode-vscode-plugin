/**
 * PermissionHandler — port of cc-gui `handler/PermissionHandler.java`
 * (opencode subset). Bridges daemon `[PERMISSION_REQUEST]`/`[QUESTION_REQUEST]`
 * events to the webview dialog and routes decisions back to the daemon
 * (`opencode.replyPermission` / `opencode.replyQuestion`, Phase 4 wiring).
 */
import { appendFileSync } from 'node:fs';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import type { PermissionRequest } from '../session/types';
import { NotificationService } from '../notifications/NotificationService';
import type { PromptRegistry } from '../prompt/PromptRegistry';
import { logDiagnostic } from '../util/DiagnosticLogger';
import { PluginFileLogger } from '../util/PluginFileLogger';

const SUPPORTED_TYPES = ['permission_decision', 'ask_user_question_response', 'ask_user_question_reject', 'plan_approval_response'];

interface PendingPermission {
	sessionId: string | null;
	permissionId: string;
	toolName: string;
	directory?: string | null;
}

interface PendingQuestion {
	sessionId: string | null;
	questions: Array<Record<string, unknown>>;
	toolName: string;
	directory?: string | null;
}

export class PermissionHandler extends BaseMessageHandler {
	private readonly pendingPermissions = new Map<string, PendingPermission>();
	private readonly pendingQuestions = new Map<string, PendingQuestion>();
	private readonly notifications: NotificationService;
	/**
	 * 未决 prompt 的 tab 归属索引（由 ChatWindow 注入）。
	 *
	 * 关 tab 时宿主必须主动 deny/reject 该 tab 的未决请求，否则服务端会一直
	 * 等一个再也不会有人回答的 prompt，后续回合全卡在那里。
	 */
	private prompts: PromptRegistry | null = null;
	/** sessionId → tabId（多 tab 下弹窗归属）。 */
	private resolveTabId: ((sessionId: string | null) => string | null) | null = null;

	private debugLog(msg: string): void {
		const line = `${new Date().toISOString()} [PermissionHandler] ${msg}\n`;
		try { appendFileSync('/tmp/permission-debug.log', line); } catch { /* ignore */ }
		logDiagnostic(`[PermissionHandler]${msg}`);
		console.log(`[PermissionHandler] ${msg}`);
	}

	constructor(context: HandlerContext) {
		super(context);
		this.notifications = new NotificationService(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	/**
	 * 注入未决 prompt 的归属索引（多 tab）。
	 *
	 * @param registry    ChatWindow 的 PromptRegistry（关 tab 时按 tab 拒绝）
	 * @param resolveTabId sessionId → tabId；会话还没绑定时退回活跃 tab
	 */
	attachPromptRegistry(
		registry: PromptRegistry | null,
		resolveTabId: ((sessionId: string | null) => string | null) | null,
	): void {
		this.prompts = registry;
		this.resolveTabId = resolveTabId;
	}

	/** 该会话所属 tab（解析不出来时返回 null，调用方按「不登记」处理）。 */
	private tabIdForSession(sessionId: string | null): string | null {
		return this.resolveTabId ? this.resolveTabId(sessionId) : null;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'permission_decision':
				this.handlePermissionDecision(content);
				return true;
			case 'ask_user_question_response':
				this.handleAskUserQuestionResponse(content);
				return true;
			case 'ask_user_question_reject':
				this.handleAskUserQuestionReject(content);
				return true;
			case 'plan_approval_response':
				// opencode 无 plan approval 概念；忽略并关闭对话框
				this.forceCloseFrontendDialog('forceClosePlanApprovalDialog');
				return true;
			default:
				return false;
		}
	}

	/**
	 * v2 提示答复入口（`permission.reply` / `question.reply` / `plan.reply`）。
	 *
	 * 命令已经由 ChatWindow 路由到目标 tab；这里再核对 pending 的 tab/session
	 * 归属。过期对话框、另一个 tab 的迟到答复都不会落到当前会话。
	 */
	handleReplyCommand(type: string, payload: Record<string, unknown>, tabId: string | null): void {
		const requestId = type === 'permission.reply'
			? this.stringField(payload.channelId)
			: this.stringField(payload.requestId);
		if (!requestId) {
			return;
		}
		if (type === 'plan.reply') {
			// opencode 没有 plan approval；保留关闭对话框的语义。
			this.prompts?.forget(requestId);
			this.forceCloseFrontendDialog('forceClosePlanApprovalDialog');
			return;
		}
		const pending = type === 'permission.reply'
			? this.pendingPermissions.get(requestId)
			: this.pendingQuestions.get(requestId);
		if (!pending) {
			PluginFileLogger.warn('PermissionHandler', `${type} for unknown prompt ${requestId}`);
			return;
		}
		const replySessionId = this.stringField(payload.sessionId) || null;
		if (!this.replyMatchesOwner(requestId, replySessionId, tabId, pending.sessionId)) {
			PluginFileLogger.warn('PermissionHandler', `${type} refused: owner mismatch for ${requestId}`);
			return;
		}
		if (type === 'permission.reply') {
			this.handlePermissionDecision(JSON.stringify(payload));
			return;
		}
		if (payload.rejected === true) {
			this.handleAskUserQuestionReject(JSON.stringify(payload));
			return;
		}
		this.handleAskUserQuestionResponse(JSON.stringify(payload));
	}

	private stringField(value: unknown): string {
		return typeof value === 'string' ? value : '';
	}

	/**
	 * The tab that owns a prompt and the tab that answered must agree, and so
	 * must their sessions. Missing identities are tolerated (legacy calls).
	 */
	private replyMatchesOwner(
		requestId: string,
		replySessionId: string | null,
		replyTabId: string | null,
		ownerSessionId: string | null,
	): boolean {
		if (ownerSessionId && replySessionId && ownerSessionId !== replySessionId) {
			return false;
		}
		const ownerTabId = this.prompts?.tabIdOf(requestId) ?? null;
		if (ownerTabId && replyTabId && ownerTabId !== replyTabId) {
			return false;
		}
		return true;
	}

	/** 由 OpenCodeSession 的 SessionCallbackAdapter 注入：收到 daemon 权限/提问请求。 */
	onPermissionRequested(request: PermissionRequest): void {
		this.debugLog(`onPermissionRequested type=${request.type} toolUseId=${request.toolUseId} requestId=${request.requestId} toolName=${request.toolName} sessionId=${request.sessionId} directory=${request.directory}`);
		if (request.type === 'question') {
			this.onQuestionRequested(request);
			return;
		}
		const sessionId = request.sessionId ?? null;
		if (!sessionId) {
			// INV-5 / §10.7：缺失身份不得借用活跃会话。适配器本应盖章，
			// 走到这里说明上游丢了身份，记录后仍把请求交给用户（服务端在等）。
			PluginFileLogger.warn('PermissionHandler', 'permission request without sessionId');
		}
		// channelId 是前端卡片/对话框的关联键（优先 toolUseId，与卡片 placeCard 一致）；
		// permissionId 是 opencode SDK replyPermission 需要的 per_xxx，必须优先取 requestId，
		// 否则会把 call_xxx 当 permissionId 回传导致 replyPermission failed。
		const channelId = request.toolUseId || request.requestId || request.toolName || 'permission-1';
		const permissionId = request.requestId || request.toolUseId || channelId;
		const directory = request.directory
			?? this.context.resolveEffectiveWorkingDirectory()
			?? this.context.getFallbackWorkingDirectory()
			?? null;
		this.debugLog(`onPermissionRequested storing channelId=${channelId} sessionId=${sessionId} permissionId=${permissionId} directory=${directory}`);
		const tabId = request.tabId ?? this.tabIdForSession(sessionId);
		this.pendingPermissions.set(channelId, {
			sessionId,
			permissionId,
			toolName: request.toolName,
			directory,
		});
		if (tabId) {
			this.prompts?.rememberPermissionTab(channelId, tabId);
		}
		this.callJavaScript(
			'showPermissionDialog',
			JSON.stringify({
				channelId,
				sessionId,
				tabId,
				toolName: request.toolName ?? request.tool ?? '',
				description: request.description ?? '',
				inputs: request.inputs ?? { command: request.description ?? '' },
			}),
		);
		// 触发权限提醒提示音（与 AskUserQuestion 共用"提问提示音"开关）。
		// 此前权限分支完全漏接，导致"审批权限时没有提示音"。
		this.notifications.onPermissionRequested();
	}

	onQuestionRequested(request: PermissionRequest): void {
		const requestId = request.requestId ?? request.toolUseId ?? 'question-1';
		const directory = request.directory
			?? this.context.resolveEffectiveWorkingDirectory()
			?? this.context.getFallbackWorkingDirectory()
			?? null;
		this.debugLog(`onQuestionRequested requestId=${requestId} sessionId=${request.sessionId} toolName="${request.toolName}" toolNameType=${typeof request.toolName} questions=${request.questions?.length ?? 0} directory=${directory}`);
		const questionSessionId = request.sessionId ?? null;
		const tabId = request.tabId ?? this.tabIdForSession(questionSessionId);
		this.pendingQuestions.set(requestId, {
			sessionId: questionSessionId,
			questions: request.questions ?? [],
			toolName: request.tool ?? request.toolName ?? '',
			directory,
		});
		if (tabId) {
			this.prompts?.rememberQuestionTab(requestId, tabId);
		}
		const payload = JSON.stringify({
			requestId,
			tabId,
			sessionId: questionSessionId,
			// normalizeQuestionRequest 返回字段名为 tool，直接回传即可；
			// toolName 留空会让前端只能走模糊 name 匹配，导致问题卡片错位。
			toolName: request.tool ?? request.toolName,
			questions: request.questions ?? [],
		});
		this.debugLog(`onQuestionRequested calling showAskUserQuestionDialog payload=${payload.slice(0, 300)}`);
		this.callJavaScript(
			'showAskUserQuestionDialog',
			payload,
		);
		// 触发提问提醒：系统通知 + 提示音（受对应开关与"仅未聚焦时"门控）。
		// 此前漏接，导致"提问系统通知""提问提示音"两个设置形同虚设。
		this.notifications.onQuestionRequested();
	}

	/**
	 * 服务端已答复/取消某个未决 prompt（回合中止、超时或在其他入口作答）。
	 * 同步移除 webview 中对应的 pending 卡片，避免"幽灵卡片"残留——
	 * 否则用户稍后对已失效的请求提交答案会得到 Question not found。
	 */
	onPromptClosed(kind: 'question' | 'permission', content: string): void {
		logDiagnostic(`[PermissionHandler] onPromptClosed kind=${kind} content=${content}`);
		try {
			const payload = JSON.parse(content) as Record<string, unknown>;
			if (kind === 'question') {
				const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
				if (requestId) {
					logDiagnostic(`[PermissionHandler] onPromptClosed deleting pendingQuestions[${requestId}], had=${this.pendingQuestions.has(requestId)}`);
					this.pendingQuestions.delete(requestId);
					this.prompts?.forget(requestId);
					this.callJavaScript('forceCloseAskUserQuestionDialog', JSON.stringify(requestId));
				}
			} else {
				const permissionId = typeof payload?.permissionId === 'string' ? payload.permissionId : '';
				const toolUseId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : '';
				if (permissionId || toolUseId) {
					// pendingPermissions 以 channelId（call_xxx）为键，而 PERMISSION_CLOSED
					// 携带的是 permissionId（per_xxx）——需要反查匹配的条目再删。
					let matchedChannelId = toolUseId && this.pendingPermissions.has(toolUseId) ? toolUseId : '';
					if (!matchedChannelId) {
						for (const [key, value] of this.pendingPermissions) {
							if (value.permissionId === permissionId) {
								matchedChannelId = key;
								break;
							}
						}
					}
					if (matchedChannelId) {
						logDiagnostic(`[PermissionHandler] onPromptClosed deleting pendingPermissions[${matchedChannelId}], had=true`);
						this.pendingPermissions.delete(matchedChannelId);
						this.prompts?.forget(matchedChannelId);
						this.callJavaScript('forceClosePermissionDialog', JSON.stringify(matchedChannelId));
					}
				}
			}
		} catch {
			// 解析失败忽略
		}
	}

	/**
	 * 关 tab 时主动拒绝该 tab 的未决 prompt。
	 *
	 * 只把对话框关掉是不够的：服务端还在等一个永远不会有人回答的请求，
	 * 那个会话的后续回合会一直卡住。所以这里对每条未决项都回一次
	 * deny / rejectQuestion。
	 */
	rejectPrompts(requestIds: string[]): void {
		if (!requestIds || requestIds.length === 0) {
			return;
		}
		const daemon = this.context.getDaemon();

		for (const requestId of requestIds) {
			const permission = this.pendingPermissions.get(requestId);
			if (permission) {
				this.pendingPermissions.delete(requestId);
				this.prompts?.forget(requestId);
				this.callJavaScript('forceClosePermissionDialog', JSON.stringify(requestId));
				logDiagnostic(`[PermissionHandler] tab closed: denying permission ${requestId}`);
				if (daemon) {
					void daemon.request('opencode.replyPermission', {
						sessionId: permission.sessionId ?? undefined,
						permissionID: permission.permissionId,
						reply: 'deny',
						rejectMessage: '会话已关闭',
						directory: permission.directory ?? undefined,
					}, { onLine: () => {}, onError: () => {}, onComplete: () => {} });
				}
				continue;
			}

			const question = this.pendingQuestions.get(requestId);
			if (question) {
				this.pendingQuestions.delete(requestId);
				this.prompts?.forget(requestId);
				this.callJavaScript('forceCloseAskUserQuestionDialog', JSON.stringify(requestId));
				logDiagnostic(`[PermissionHandler] tab closed: rejecting question ${requestId}`);
				if (daemon) {
					void daemon.request('opencode.rejectQuestion', {
						sessionId: question.sessionId ?? undefined,
						questionID: requestId,
						directory: question.directory ?? undefined,
					}, { onLine: () => {}, onError: () => {}, onComplete: () => {} });
				}
			}
		}
	}

	clearPendingRequests(): void {		this.pendingPermissions.clear();
		this.pendingQuestions.clear();
		this.forceCloseFrontendDialog('forceClosePermissionDialog');
		this.forceCloseFrontendDialog('forceCloseAskUserQuestionDialog');
		this.forceCloseFrontendDialog('forceClosePlanApprovalDialog');
	}

	private handlePermissionDecision(content: string): void {
		try {
			const decision = JSON.parse(content) as Record<string, unknown>;
			const channelId = typeof decision?.channelId === 'string' ? decision.channelId : '';
			const allow = decision?.allow === true;
			const remember = decision?.remember === true;
			const rejectMessage = typeof decision?.rejectMessage === 'string' ? decision.rejectMessage : '';

			this.debugLog(`[P] >>> received channelId=${channelId} allow=${allow} pendingPermissions=${this.pendingPermissions.size} keys=[${[...this.pendingPermissions.keys()].join(',')}]`);
			const pending = this.pendingPermissions.get(channelId);
			if (!pending) {
				this.debugLog(`[P] channelId=${channelId} NOT in pendingPermissions — early return`);
				return;
			}
			this.pendingPermissions.delete(channelId);
			this.prompts?.forget(channelId);

			const daemon = this.context.getDaemon();
			if (!daemon) {
				this.debugLog(`[P] channelId=${channelId} no daemon — early return`);
				return;
			}
			this.debugLog(`[P] channelId=${channelId} calling replyPermission sessionId=${pending.sessionId} permissionId=${pending.permissionId} directory=${pending.directory}`);
			void daemon.request(
				'opencode.replyPermission',
				{
					sessionId: pending.sessionId ?? undefined,
					permissionID: pending.permissionId,
					reply: allow ? (remember ? 'allowAlways' : 'allow') : 'deny',
					rejectMessage,
					directory: pending.directory ?? undefined,
				},
				{
					onLine: () => {},
					onError: (error) => {
						this.debugLog(`[P] channelId=${channelId} replyPermission onError: ${error}`);
						this.handleReplyFailure(`权限回复失败: ${error}`, undefined, channelId);
					},
					onComplete: () => {
						this.debugLog(`[P] channelId=${channelId} replyPermission onComplete`);
					},
				},
			);
		} catch (err) {
			this.debugLog(`Failed to parse permission_decision: ${String(err)}`);
		}
	}

	private handleAskUserQuestionResponse(content: string): void {
		try {
			const response = JSON.parse(content) as Record<string, unknown>;
			const requestId = typeof response?.requestId === 'string' ? response.requestId : '';
			const answers = (response?.answers ?? {}) as Record<string, unknown>;
		this.debugLog(`[Q] >>> received requestId=${requestId} pendingQuestions=${this.pendingQuestions.size} keys=[${[...this.pendingQuestions.keys()].join(',')}]`);
		const pending = this.pendingQuestions.get(requestId);
		if (!pending) {
			this.debugLog(`[Q] requestId=${requestId} NOT in pendingQuestions — early return`);
			return;
		}
		this.pendingQuestions.delete(requestId);
		this.prompts?.forget(requestId);
		// Emit complete Q&A data to webview so it can render the summary card
		// without needing to match tool_use_id across messages.
		const onQAData = {
			callId: pending.toolName,
			requestId,
			questions: pending.questions,
			answers,
		};
		this.debugLog(`[Q] >>> onQuestionAnswered callId="${pending.toolName}" requestId="${requestId}" questions=${pending.questions.length} answers=${JSON.stringify(answers).substring(0, 200)}`);
		console.log(`[PermissionHandler] onQuestionAnswered callId="${pending.toolName}" requestId="${requestId}"`, onQAData);
		this.callJavaScript('onQuestionAnswered', JSON.stringify(onQAData));
		const daemon = this.context.getDaemon();
			if (!daemon) {
				this.debugLog(`[Q] requestId=${requestId} no daemon — early return`);
				return;
			}
			const orderedAnswers = buildOrderedAnswers(pending.questions, answers);
			this.debugLog(`[Q] requestId=${requestId} calling replyQuestion sessionId=${pending.sessionId} directory=${pending.directory}`);
			void daemon.request(
				'opencode.replyQuestion',
				{
					sessionId: pending.sessionId ?? undefined,
					questionID: requestId,
					answers: orderedAnswers,
					directory: pending.directory ?? undefined,
				},
				{
					onLine: () => {},
					onError: (error) => {
						this.debugLog(`[Q] requestId=${requestId} replyQuestion onError: ${error}`);
						this.handleReplyFailure(`回答提交失败: ${error}`, requestId);
					},
					onComplete: () => {
						this.debugLog(`[Q] requestId=${requestId} replyQuestion onComplete`);
					},
				},
			);
		} catch (err) {
			this.debugLog(`[Q] Failed to parse: ${String(err)}`);
		}
	}

	/** 用户「跳过」问题：通知 opencode 拒绝该 question 请求，会话继续。 */
	private handleAskUserQuestionReject(content: string): void {
		try {
			const response = JSON.parse(content) as Record<string, unknown>;
			const requestId = typeof response?.requestId === 'string' ? response.requestId : '';
			const pending = this.pendingQuestions.get(requestId);
			if (!pending) {
				return;
			}
			this.pendingQuestions.delete(requestId);
			this.prompts?.forget(requestId);
			const daemon = this.context.getDaemon();
			if (!daemon) {
				return;
			}
			void daemon.request(
				'opencode.rejectQuestion',
				{
					sessionId: pending.sessionId ?? undefined,
					questionID: requestId,
					directory: pending.directory ?? undefined,
				},
				{
					onLine: () => {},
					onError: (error) => this.handleReplyFailure(`跳过问题失败: ${error}`),
					onComplete: () => {},
				},
			);
		} catch (err) {
			logDiagnostic(`[PermissionHandler] Failed to parse ask_user_question_reject: ${String(err)}`);
		}
	}

	/**
	 * 回复送达失败（daemon 返回 success:false / 请求异常）：
	 * toast 告知用户具体原因。
	 * 对卡片：把已乐观置为"已回答/已允许/已拒绝"的记录如实翻转为失效状态，
	 * 避免调用破坏性的 sendAbort() 强行杀死整个正在运行的对话循环。
	 */
	private handleReplyFailure(message: string, questionRequestId?: string, permissionChannelId?: string): void {
		logDiagnostic(`[PermissionHandler] handleReplyFailure: ${message} questionRequestId=${questionRequestId ?? 'N/A'} permissionChannelId=${permissionChannelId ?? 'N/A'}`);
		this.callJavaScript('showToast', JSON.stringify(message));
		if (questionRequestId) {
			logDiagnostic(`[PermissionHandler] calling invalidateQuestionCard(${questionRequestId})`);
			this.callJavaScript('invalidateQuestionCard', JSON.stringify(questionRequestId));
		}
		if (permissionChannelId) {
			logDiagnostic(`[PermissionHandler] calling invalidatePermissionCard(${permissionChannelId})`);
			this.callJavaScript('invalidatePermissionCard', JSON.stringify(permissionChannelId));
		}
	}

	private forceCloseFrontendDialog(fnName: string): void {
		this.callJavaScript(fnName, '');
	}
}

/**
 * 把前端 `{questionText: string | string[]}` 的答案映射为 opencode v2 reply
 * 所需的 `string[][]`（按原 questions 顺序，每个元素是对应题目的选中标签数组）。
 */
function buildOrderedAnswers(
	questions: Array<Record<string, unknown>>,
	answers: Record<string, unknown>,
): string[][] {
	const ordered: string[][] = [];
	for (const q of questions ?? []) {
		const qText = typeof q?.question === 'string' ? q.question : '';
		const value = qText ? answers[qText] : undefined;
		if (Array.isArray(value)) {
			ordered.push(value.filter((v): v is string => typeof v === 'string'));
		} else if (typeof value === 'string') {
			ordered.push([value]);
		} else {
			ordered.push([]);
		}
	}
	return ordered;
}
