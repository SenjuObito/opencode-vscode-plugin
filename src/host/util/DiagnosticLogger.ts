/**
 * DiagnosticLogger — VS Code 输出通道「OpenCode Buddy」。
 * 用户可在 输出窗口 → 下拉选择「OpenCode Buddy」查看分享/撤销/分叉等
 * 操作的全链路诊断日志；同时镜像到扩展宿主 console（Debug Console 可见）。
 */
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('OpenCode Buddy');
	}
	return channel;
}

/** 输出一行诊断日志（带时间戳前缀）。 */
export function logDiagnostic(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`;
	try {
		getChannel().appendLine(line);
	} catch {
		// OutputChannel 不可用时静默降级
	}
	console.log(`[OpenCodeGUI] ${message}`);
}

/** 输出多行内容（如 daemon 原始响应 chunks）。 */
export function logDiagnosticBlock(title: string, body: string): void {
	logDiagnostic(`${title}:`);
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}
		try {
			getChannel().appendLine(`    ${line}`);
		} catch {
			// ignore
		}
	}
}

export function disposeDiagnosticLogger(): void {
	channel?.dispose();
	channel = null;
}
