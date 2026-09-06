/**
 * DiagnosticLogger — VS Code 输出通道「OpenCode」。
 * 用户可在 输出窗口 → 下拉选择「OpenCode」查看分享/撤销/分叉等
 * 操作的全链路诊断日志；同时镜像到扩展宿主 console（Debug Console 可见）。
 *
 * 内存约束：OutputChannel 的内容常驻宿主内存且 appendLine 无界累积——
 * 高频路径（每条 webview→host 消息、daemon stderr）长期使用会累积数十 MB。
 * 两条对策：
 *   1. 高频日志走 logVerbose()，仅 verbose 模式（settings 开关）下写入；
 *   2. 通道超过 MAX_CHANNEL_CHARS 时 clear() 并写入截断标记（丢历史保内存）。
 */
import * as vscode from 'vscode';

/**
 * 构建级别（esbuild define 注入，见 esbuild.js）：
 *   production（`pnpm run package`）→ info 级诊断全部静默，只留 error
 *   development（compile/watch）    → info 级诊断正常输出
 */
const PROD_BUILD = process.env.NODE_ENV === 'production';

let channel: vscode.OutputChannel | null = null;
let verbose = false;
/** 近似累计写入字符数（跨 clear 重置），用于触发通道截断。 */
let channelChars = 0;

const MAX_CHANNEL_CHARS = 2_000_000;
const TRUNCATION_NOTICE = '[DiagnosticLogger] 输出达到 2MB 上限，已清空以控制扩展宿主内存占用。\n';

/** 设置 verbose 诊断开关（默认关）。由 extension.ts 依用户设置接线。 */
export function setDiagnosticVerbose(enabled: boolean): void {
	verbose = enabled;
}

export function isDiagnosticVerbose(): boolean {
	return verbose;
}

function getChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('OpenCode');
	}
	return channel;
}

function appendToChannel(line: string): void {
	try {
		if (channelChars >= MAX_CHANNEL_CHARS) {
			getChannel().clear();
			channelChars = 0;
			getChannel().appendLine(TRUNCATION_NOTICE);
			channelChars += TRUNCATION_NOTICE.length;
		}
		getChannel().appendLine(line);
		channelChars += line.length + 1;
	} catch {
		// OutputChannel 不可用时静默降级
	}
}

/** 输出一行诊断日志（带时间戳前缀）。info 级——生产包静默。 */
export function logDiagnostic(message: string): void {
	if (PROD_BUILD) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${message}`;
	appendToChannel(line);
	console.log(`[OpenCodeGUI] ${message}`);
}

/** 高频诊断：info 级，且开发模式下还需 verbose 开启。 */
export function logVerbose(message: string): void {
	if (PROD_BUILD || !verbose) {
		return;
	}
	logDiagnostic(message);
}

/** 输出多行内容（如 daemon 原始响应 chunks）。info 级——生产包静默。 */
export function logDiagnosticBlock(title: string, body: string): void {
	if (PROD_BUILD) {
		return;
	}
	logDiagnostic(`${title}:`);
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}
		appendToChannel(`    ${line}`);
		channelChars += 5;
	}
}

/** error 级诊断：任何构建级别都输出（生产包唯一可见的通道日志）。 */
export function logError(message: string): void {
	const line = `[${new Date().toISOString()}] [ERROR] ${message}`;
	appendToChannel(line);
	console.error(`[OpenCodeGUI] ${message}`);
}

export function disposeDiagnosticLogger(): void {
	channel?.dispose();
	channel = null;
	channelChars = 0;
}
