import * as assert from 'assert';
import { SessionMarkdownFormatter } from '../host/export/SessionMarkdownFormatter';
import type { SdkMessageEntry } from '../host/session/SdkMessageConverter';

suite('SessionMarkdownFormatter', () => {
	test('formats session metadata and messages correctly', () => {
		const meta = {
			id: 'ses_test_123',
			title: '测试导出会话',
			createdAt: 1773738000000,
			model: 'anthropic/claude-3-7-sonnet',
			agent: 'coder',
			tokens: {
				input: 100,
				output: 200,
				reasoning: 50,
			},
		};

		const entries: SdkMessageEntry[] = [
			{
				info: { role: 'user' },
				parts: [{ type: 'text', text: '你好，请帮我写一段代码' }],
			},
			{
				info: { role: 'assistant' },
				parts: [
					{ type: 'reasoning', text: '用户需要写一段代码，我来构思一下' },
					{ type: 'text', text: '这是为你准备的代码：' },
					{
						type: 'tool',
						tool: 'write_to_file',
						state: {
							status: 'completed',
							input: { path: 'test.ts', content: 'console.log("hello");' },
							output: 'File created successfully',
						},
					},
					{ type: 'file', filename: 'test.ts' },
				],
			},
		];

		const markdown = SessionMarkdownFormatter.format(meta, entries);

		assert.ok(markdown.includes('# 💬 测试导出会话'));
		assert.ok(markdown.includes('> **会话 ID**: `ses_test_123`'));
		assert.ok(markdown.includes('> **模型**: `anthropic/claude-3-7-sonnet`'));
		assert.ok(markdown.includes('> **Agent**: `coder`'));
		assert.ok(markdown.includes('> **Token 统计**: 输入: 100 | 输出: 200 | 思考: 50'));

		// User
		assert.ok(markdown.includes('### 🧑 User'));
		assert.ok(markdown.includes('你好，请帮我写一段代码'));

		// Assistant
		assert.ok(markdown.includes('### 🤖 Assistant'));
		assert.ok(markdown.includes('<details>\n<summary>💭 思考过程 (Reasoning)</summary>'));
		assert.ok(markdown.includes('用户需要写一段代码，我来构思一下'));
		assert.ok(markdown.includes('这是为你准备的代码：'));
		assert.ok(markdown.includes('🔧 工具调用: <code>write_to_file</code>'));
		assert.ok(markdown.includes('test.ts'));
		assert.ok(markdown.includes('📎 **附件/文件**: `test.ts`'));
	});
});
