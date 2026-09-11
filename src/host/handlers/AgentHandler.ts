/**
 * AgentHandler — port of cc-gui `handler/AgentHandler.java` (opencode subset).
 * opencode agents = SDK `app.agents`（常驻 daemon 枚举）。`get_agents` 从
 * daemon 拉取并映射成前端 `AgentItem`（{ id, name, prompt }）数组。
 *
 * Frontend: `sendToJava('get_agents')` → `window.updateAgents([...])`。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';

const SUPPORTED_TYPES = ['get_agents'];

	interface AgentItem {
	id: string;
	name: string;
	prompt?: string;
	/** opencode agent mode: 'primary' = 主代理(Build/Plan/自定义), 'subagent' = 子代理(General/Explore/Scout), 'all' = 聚合 */
	mode?: 'primary' | 'subagent' | 'all' | string;
	/** 隐藏的系统代理(Compaction/Title/Summary) 不对外暴露 */
	hidden?: boolean;
	/** SDK 自带的简短描述，优先用于下拉展示 */
	description?: string;
}

export class AgentHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_agents':
				this.handleGetAgents();
				return true;
			default:
				return false;
		}
	}

	private handleGetAgents(): void {
		const daemon = this.context.getDaemon();
		if (!daemon) {
			this.pushAgents([]);
			return;
		}

		const directory = this.context.resolveEffectiveWorkingDirectory() ?? undefined;
		const chunks: string[] = [];
		void daemon.request('opencode.listAgents', { directory }, {
			onLine: (line) => chunks.push(line),
			onError: () => this.pushAgents([]),
			onComplete: (success) => {
				if (!success) {
					this.pushAgents([]);
					return;
				}
				const payload = this.extractJsonObject(chunks.join('\n'));
				const raw = payload && Array.isArray(payload.agents) ? payload.agents : [];
				const agents = raw
					.map((a) => {
						const agent = a as Record<string, unknown>;
						// SDK app.agents 以 name 作为标识（无 id 字段）。
						const name = typeof agent?.name === 'string' && agent.name !== '' ? agent.name : '';
						if (!name) {
							return null;
						}
					return {
						id: typeof agent.id === 'string' ? agent.id : name,
						name,
						prompt: typeof agent.prompt === 'string' ? agent.prompt : undefined,
						mode: typeof agent.mode === 'string' ? agent.mode : undefined,
						hidden: typeof agent.hidden === 'boolean' ? agent.hidden : undefined,
						description: typeof agent.description === 'string' ? agent.description : undefined,
					} as AgentItem;
					})
					.filter((a): a is AgentItem => a !== null);
				this.pushAgents(agents);
			},
		});
	}

	private pushAgents(agents: AgentItem[]): void {
		this.callJavaScript('updateAgents', JSON.stringify(agents));
	}

	/** 从 daemon 输出缓冲区提取 JSON 对象（容错非 JSON 诊断行）。 */
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
				if (obj && (obj.agents !== undefined || obj.success !== undefined)) {
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
}
