/**
 * DiagnosticLogger — VS Code 输出通道「OpenCode」与独立文件日志记录器。
 * 1. 文件日志（PluginFileLogger）：默认写入 ~/Library/Logs/opencode-vscode-plugin/opencode-plugin.log
 *    持久化记录全链路通信、Daemon 请求与异常，支持 8MB 文件大小轮转。
 * 2. VS Code 输出通道（OutputChannel）：用户可在 输出窗口 → 下拉选择「OpenCode」查看实时诊断。
 */
import * as vscode from 'vscode';
import { PluginFileLogger } from './PluginFileLogger';

/**
 * 构建级别（esbuild define 注入，见 esbuild.js）：
 *   production（`pnpm run package`）→ info 级通道输出静默（文件日志仍保留记录），只留 error
 *   development（compile/watch）    → info 级通道输出正常展示
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

/** 输出一行诊断日志（写入文件日志并在开发模式输出到通道）。 */
export function logDiagnostic(message: string, tag: string = 'Host'): void {
	PluginFileLogger.info(tag, message);
	if (PROD_BUILD) {
		return;
	}
	const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
	appendToChannel(line);
	console.log(`[OpenCodeGUI] [${tag}] ${message}`);
}

/** 高频诊断：写入文件调试级别，且在开发模式 + verbose 开启时输出到通道。 */
export function logVerbose(message: string, tag: string = 'Verbose'): void {
	PluginFileLogger.debug(tag, message);
	if (PROD_BUILD || !verbose) {
		return;
	}
	logDiagnostic(message, tag);
}

/** 输出多行内容（如 daemon 原始响应 chunks）。 */
export function logDiagnosticBlock(title: string, body: string): void {
	PluginFileLogger.info('Block', `${title}: ${body.replace(/\r?\n/g, ' ')}`);
	if (PROD_BUILD) {
		return;
	}
	logDiagnostic(`${title}:`, 'Block');
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}
		appendToChannel(`    ${line}`);
		channelChars += 5;
	}
}

/** warn 级诊断：写入文件与通道。 */
export function logWarn(message: string, tag: string = 'Host'): void {
	PluginFileLogger.warn(tag, message);
	const line = `[${new Date().toISOString()}] [WARN] [${tag}] ${message}`;
	appendToChannel(line);
	console.warn(`[OpenCodeGUI] [${tag}] ${message}`);
}

/** error 级诊断：任何构建级别都输出（写入文件并在通道与控制台显式展示）。 */
export function logError(message: string, error?: unknown, tag: string = 'Host'): void {
	PluginFileLogger.error(tag, message, error);
	const errorSuffix = error ? (error instanceof Error ? ` (${error.name}: ${error.message})` : ` (${String(error)})`) : '';
	const line = `[${new Date().toISOString()}] [ERROR] [${tag}] ${message}${errorSuffix}`;
	appendToChannel(line);
	console.error(`[OpenCodeGUI] [${tag}] ${message}`, error || '');
}

export function disposeDiagnosticLogger(): void {
	PluginFileLogger.getInstance().close();
	channel?.dispose();
	channel = null;
	channelChars = 0;
}
