/**
 * SessionMarkdownFormatter — formats OpenCode SDK session message entries
 * (`SdkMessageEntry[]`) and session metadata into standard Markdown document.
 */
import type { SdkMessageEntry, SdkPart } from '../session/SdkMessageConverter';

export interface ExportSessionMetadata {
	id: string;
	title?: string;
	createdAt?: number;
	updatedAt?: number;
	model?: string;
	agent?: string;
	provider?: string;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export class SessionMarkdownFormatter {
	/**
	 * 将 OpenCode 会话元数据与消息列表格式化为 Markdown 字符串。
	 */
	public static format(
		meta: ExportSessionMetadata,
		entries: SdkMessageEntry[],
	): string {
		const lines: string[] = [];

		// 1. Header & 元信息
		const title = meta.title?.trim() || 'Untitled Session';
		lines.push(`# 💬 ${title}\n`);

		const metaItems: string[] = [];
		if (meta.id) {
			metaItems.push(`> **会话 ID**: \`${meta.id}\``);
		}
		if (meta.createdAt) {
			metaItems.push(`> **创建时间**: \`${this.formatTime(meta.createdAt)}\``);
		}
		if (meta.updatedAt && meta.updatedAt !== meta.createdAt) {
			metaItems.push(`> **更新时间**: \`${this.formatTime(meta.updatedAt)}\``);
		}
		if (meta.model) {
			metaItems.push(`> **模型**: \`${meta.model}\``);
		}
		if (meta.agent) {
			metaItems.push(`> **Agent**: \`${meta.agent}\``);
		}
		if (meta.tokens) {
			const tokenParts: string[] = [];
			if (meta.tokens.input !== undefined) {
				tokenParts.push(`输入: ${meta.tokens.input.toLocaleString()}`);
			}
			if (meta.tokens.output !== undefined) {
				tokenParts.push(`输出: ${meta.tokens.output.toLocaleString()}`);
			}
			if (meta.tokens.reasoning !== undefined) {
				tokenParts.push(`思考: ${meta.tokens.reasoning.toLocaleString()}`);
			}
			if (tokenParts.length > 0) {
				metaItems.push(`> **Token 统计**: ${tokenParts.join(' | ')}`);
			}
		}

		if (metaItems.length > 0) {
			lines.push(metaItems.join('  \n'));
			lines.push('\n---\n');
		}

		// 2. 遍历并格式化消息列表
		const validEntries = Array.isArray(entries) ? entries : [];
		for (const entry of validEntries) {
			const info = entry?.info ?? {};
			const parts = Array.isArray(entry?.parts) ? entry.parts : [];
			const role = info.role || '';

			if (role === 'user') {
				lines.push(`### 🧑 User\n`);
				const formatted = this.formatParts(parts);
				lines.push(formatted || '*(空消息)*');
				lines.push('\n---\n');
			} else if (role === 'assistant') {
				lines.push(`### 🤖 Assistant\n`);
				const formatted = this.formatParts(parts);
				lines.push(formatted || '*(无回复内容)*');
				lines.push('\n---\n');
			} else if (role === 'system') {
				lines.push(`### ⚙️ System\n`);
				const formatted = this.formatParts(parts);
				lines.push(formatted || '*(系统消息)*');
				lines.push('\n---\n');
			}
		}

		return lines.join('\n');
	}

	private static formatParts(parts: SdkPart[]): string {
		const out: string[] = [];

		for (const part of parts) {
			if (!part || typeof part !== 'object') {
				continue;
			}

			switch (part.type) {
				case 'text': {
					if (typeof part.text === 'string' && part.text.trim()) {
						out.push(part.text.trim());
					}
					break;
				}
				case 'reasoning': {
					if (typeof part.text === 'string' && part.text.trim()) {
						out.push(`<details>\n<summary>💭 思考过程 (Reasoning)</summary>\n\n${part.text.trim()}\n</details>`);
					}
					break;
				}
				case 'tool': {
					out.push(this.formatToolPart(part));
					break;
				}
				case 'file': {
					const name = part.filename || part.url || 'attachment';
					out.push(`📎 **附件/文件**: \`${name}\``);
					break;
				}
				case 'image': {
					const src = part.url || part.src;
					if (src) {
						out.push(`![image](${src})`);
					}
					break;
				}
				default: {
					// 其他未知 part，如果带 text 则输出 text
					if (typeof part.text === 'string' && part.text.trim()) {
						out.push(part.text.trim());
					}
					break;
				}
			}
		}

		return out.join('\n\n');
	}

	private static formatToolPart(part: SdkPart): string {
		const toolName = part.tool || (part as Record<string, unknown>).name || 'tool';
		const state = (part.state || {}) as {
			input?: unknown;
			output?: unknown;
			status?: string;
		};

		const statusIcon = state.status === 'error' ? '❌' : '🔧';
		let result = `<details>\n<summary>${statusIcon} 工具调用: <code>${toolName}</code></summary>\n\n`;

		if (state.input !== undefined && state.input !== null) {
			const inputStr = typeof state.input === 'string'
				? state.input
				: JSON.stringify(state.input, null, 2);
			result += `**输入参数**:\n\`\`\`json\n${inputStr}\n\`\`\`\n\n`;
		}

		if (state.output !== undefined && state.output !== null) {
			const outStr = typeof state.output === 'string'
				? state.output
				: JSON.stringify(state.output, null, 2);
			result += `**执行输出**:\n\`\`\`text\n${outStr}\n\`\`\`\n`;
		}

		result += `</details>`;
		return result;
	}

	private static formatTime(ts: number): string {
		try {
			const timeMs = ts < 100_000_000_000 ? ts * 1000 : ts;
			const d = new Date(timeMs);
			const year = d.getFullYear();
			const month = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			const hours = String(d.getHours()).padStart(2, '0');
			const minutes = String(d.getMinutes()).padStart(2, '0');
			const seconds = String(d.getSeconds()).padStart(2, '0');
			return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
		} catch {
			return String(ts);
		}
	}
}
