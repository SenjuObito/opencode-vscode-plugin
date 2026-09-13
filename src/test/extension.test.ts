import * as assert from 'assert';
import * as vscode from 'vscode';
import { sanitizeUserText, needsSanitize } from '../host/session/UserTextSanitizer';
import { parseSlashCommand } from '../host/session/OpenCodeSession';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('UserTextSanitizer strips Attached Files section', () => {
		const text = '请分析附件\n\n## Attached Files\n\n<attachment filename=".env">\nFOO=BAR\n</attachment>';
		assert.strictEqual(sanitizeUserText(text), '请分析附件');
	});

	test('UserTextSanitizer strips Referenced Files and IDE Context', () => {
		const text = '用户消息\n\n## Referenced Files\n\n- /a/b.ts\n\n## IDE Context\n\nActive file: `/a/b.ts`';
		assert.strictEqual(sanitizeUserText(text), '用户消息');
	});

	test('UserTextSanitizer needsSanitize detects injected sections', () => {
		assert.strictEqual(needsSanitize('a\n\n## Attached Files\n\n<attachment>'), true);
		assert.strictEqual(needsSanitize('a\n\n## Custom Heading\n\nb'), false);
	});

	test('parseSlashCommand recognizes valid slash commands', () => {
		assert.deepStrictEqual(parseSlashCommand('/review'), { command: 'review', arguments: '' });
		assert.deepStrictEqual(parseSlashCommand('/review src/main.rs'), { command: 'review', arguments: 'src/main.rs' });
		assert.deepStrictEqual(parseSlashCommand('/init'), { command: 'init', arguments: '' });
		assert.deepStrictEqual(parseSlashCommand('/compact'), { command: 'compact', arguments: '' });
		assert.deepStrictEqual(parseSlashCommand('/custom_cmd-1 arg1 arg2'), { command: 'custom_cmd-1', arguments: 'arg1 arg2' });
	});

	test('parseSlashCommand rejects URL paths and file paths', () => {
		// URL paths with Chinese / query / extra slashes
		assert.strictEqual(parseSlashCommand('/v2/risk-assessments/papers/acitons/submit又有动词，这不是但数码？重新修改List<QuestionVO>，发送了这条消息之后，直接就报错了。'), null);
		assert.strictEqual(parseSlashCommand('/v1/chat/completions'), null);
		assert.strictEqual(parseSlashCommand('/api/user/login'), null);

		// File paths
		assert.strictEqual(parseSlashCommand('/Users/developer/project/main.go'), null);
		assert.strictEqual(parseSlashCommand('/etc/nginx/nginx.conf'), null);
		assert.strictEqual(parseSlashCommand('/var/log/app.log'), null);

		// Plain text / empty / shell commands
		assert.strictEqual(parseSlashCommand('hello /world'), null);
		assert.strictEqual(parseSlashCommand('!git status'), null);
		assert.strictEqual(parseSlashCommand(''), null);
	});
});
