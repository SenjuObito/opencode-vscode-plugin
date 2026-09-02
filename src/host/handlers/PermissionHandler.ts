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
import { logDiagnostic } from '../util/DiagnosticLogger';

const SUPPORTED_TYPES = ['permission_decision', 'ask_user_question_response', 'ask_user_question_reject', 'plan_approval_response'];

interface PendingPermission {
	sessionId: string | null;
	permissionId: string;
	toolName: string;
}

interface PendingQuestion {
	sessionId: string | null;
	questions: Array<Record<string, unknown>>;
	toolName: string;
}

export class PermissionHandler extends BaseMessageHandler {
	private readonly pendingPermissions = new Map<string, PendingPermission>();
	private readonly pendingQuestions = new Map<string, PendingQuestion>();
	private readonly notifications: NotificationService;

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

	/** 由 OpenCodeSession 的 SessionCallbackAdapter 注入：收到 daemon 权限/提问请求。 */
	onPermissionRequested(request: PermissionRequest): void {
		this.debugLog(`onPermissionRequested type=${request.type} toolUseId=${request.toolUseId} requestId=${request.requestId} toolName=${request.toolName} sessionId=${request.sessionId}`);
		if (request.type === 'question') {
			this.onQuestionRequested(request);
			return;
		}
		const sessionId = request.sessionId ?? this.context.getSession()?.state.getSessionId() ?? null;
		// channelId 是前端卡片/对话框的关联键（优先 toolUseId，与卡片 placeCard 一致）；
		// permissionId 是 opencode SDK replyPermission 需要的 per_xxx，必须优先取 requestId，
		// 否则会把 call_xxx 当 permissionId 回传导致 replyPermission failed。
		const channelId = request.toolUseId || request.requestId || request.toolName || 'permission-1';
		const permissionId = request.requestId || request.toolUseId || channelId;
		this.debugLog(`onPermissionRequested storing channelId=${channelId} sessionId=${sessionId} permissionId=${permissionId}`);
		this.pendingPermissions.set(channelId, {
			sessionId,
			permissionId,
			toolName: request.toolName,
		});
		this.callJavaScript(
			'showPermissionDialog',
			JSON.stringify({
				channelId,
				sessionId,
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
		this.debugLog(`onQuestionRequested requestId=${requestId} sessionId=${request.sessionId} toolName="${request.toolName}" toolNameType=${typeof request.toolName} questions=${request.questions?.length ?? 0}`);
		this.pendingQuestions.set(requestId, {
			sessionId: request.sessionId ?? null,
			questions: request.questions ?? [],
			toolName: request.tool ?? request.toolName ?? '',
		});
		const payload = JSON.stringify({
			requestId,
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
						this.callJavaScript('forceClosePermissionDialog', JSON.stringify(matchedChannelId));
					}
				}
			}
		} catch {
			// 解析失败忽略
		}
	}

	clearPendingRequests(): void {
		this.pendingPermissions.clear();
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

			const daemon = this.context.getDaemon();
			if (!daemon) {
				this.debugLog(`[P] channelId=${channelId} no daemon — early return`);
				return;
			}
			this.debugLog(`[P] channelId=${channelId} calling replyPermission sessionId=${pending.sessionId} permissionId=${pending.permissionId}`);
			void daemon.request(
				'opencode.replyPermission',
				{
					sessionId: pending.sessionId ?? undefined,
					permissionID: pending.permissionId,
					reply: allow ? (remember ? 'allowAlways' : 'allow') : 'deny',
					rejectMessage,
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
			this.debugLog(`[Q] requestId=${requestId} calling replyQuestion sessionId=${pending.sessionId}`);
			void daemon.request(
				'opencode.replyQuestion',
				{ sessionId: pending.sessionId ?? undefined, questionID: requestId, answers: orderedAnswers },
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
			const daemon = this.context.getDaemon();
			if (!daemon) {
				return;
			}
			void daemon.request(
				'opencode.rejectQuestion',
				{ sessionId: pending.sessionId ?? undefined, questionID: requestId },
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
	 * toast 告知用户具体原因，并中止当前挂死的一轮 —— 否则 opencode 仍会
	 * 等待回复、session 永远 busy，前端"正在生成响应"无法结束。
	 * 对卡片：把已乐观置为"已回答/已允许/已拒绝"的记录如实翻转为失效状态。
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
		const daemon = this.context.getDaemon();
		daemon?.sendAbort();
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
