import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_LINE = 4000;

function resolveLogFile(): string {
	const envFile = process.env.OPENCODE_VSCODE_LOG_FILE || process.env.OPENCODE_PLUGIN_LOG_FILE;
	if (envFile && envFile.trim()) {
		return envFile.trim();
	}
	const home = os.homedir();
	const isMac = process.platform === 'darwin';
	if (isMac) {
		return path.join(home, 'Library', 'Logs', 'opencode-vscode-plugin', 'opencode-plugin.log');
	}
	return path.join(home, '.opencode-vscode-plugin', 'opencode-plugin.log');
}

function pad2(n: number): string {
	return n < 10 ? '0' + n : String(n);
}

function pad3(n: number): string {
	if (n < 10) {
		return '00' + n;
	}
	if (n < 100) {
		return '0' + n;
	}
	return String(n);
}

function formatTimestamp(d: Date): string {
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export class PluginFileLogger {
	private static instance: PluginFileLogger | null = null;
	private filePath: string;
	private fd: number | null = null;
	private writtenBytes: number = 0;
	private disabled: boolean = false;
	private throttles = new Map<string, [number, number]>();

	private constructor() {
		this.filePath = resolveLogFile();
		this.open();
	}

	public static getInstance(): PluginFileLogger {
		if (!PluginFileLogger.instance) {
			PluginFileLogger.instance = new PluginFileLogger();
		}
		return PluginFileLogger.instance;
	}

	public static path(): string {
		return PluginFileLogger.getInstance().filePath;
	}

	public static debug(tag: string, message: string): void {
		PluginFileLogger.getInstance().write('DEBUG', tag, message);
	}

	public static info(tag: string, message: string): void {
		PluginFileLogger.getInstance().write('INFO', tag, message);
	}

	public static warn(tag: string, message: string): void {
		PluginFileLogger.getInstance().write('WARN', tag, message);
	}

	public static error(tag: string, message: string, error?: unknown): void {
		PluginFileLogger.getInstance().write('ERROR', tag, message, error);
	}

	public static throttled(level: string, tag: string, key: string, message: string, minIntervalMs: number = 2000): void {
		PluginFileLogger.getInstance().writeThrottled(level, tag, key, message, minIntervalMs);
	}

	private open(): void {
		try {
			const dir = path.dirname(this.filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			const fresh = !fs.existsSync(this.filePath);
			this.fd = fs.openSync(this.filePath, 'a');
			const stat = fs.fstatSync(this.fd);
			this.writtenBytes = stat.size;

			const initMsg = fresh
				? `Trace file created: ${this.filePath}`
				: `--- new session, appending to ${this.filePath} ---`;
			this.writeDirect('INFO', 'FileLog', initMsg);
		} catch (err) {
			this.disabled = true;
			console.warn(`[FileLog] Failed to open ${this.filePath}:`, err);
		}
	}

	private writeThrottled(level: string, tag: string, key: string, message: string, minIntervalMs: number): void {
		const now = Date.now();
		const stateKey = `${tag}#${key}`;
		const state = this.throttles.get(stateKey) || [0, 0];
		if (now - state[0] < minIntervalMs) {
			state[1]++;
			this.throttles.set(stateKey, state);
			return;
		}
		const suppressed = state[1];
		state[0] = now;
		state[1] = 0;
		this.throttles.set(stateKey, state);

		const body = suppressed > 0 ? `${message} (suppressed ${suppressed} similar)` : message;
		this.write(level, tag, body);
	}

	public write(level: string, tag: string, message: string, error?: unknown): void {
		if (this.disabled || this.fd === null) {
			return;
		}
		try {
			this.writeDirect(level, tag, message, error);
			if (this.writtenBytes > MAX_BYTES) {
				this.rotate();
			}
		} catch (err) {
			this.disabled = true;
			console.warn(`[FileLog] Write failed:`, err);
		}
	}

	private writeDirect(level: string, tag: string, message: string, error?: unknown): void {
		if (this.fd === null) {
			return;
		}
		const stamp = formatTimestamp(new Date());
		let body = (message || '').replace(/\r?\n/g, ' ');
		if (body.length > MAX_LINE) {
			body = body.substring(0, MAX_LINE) + `...<truncated ${message.length - MAX_LINE} chars>`;
		}
		let line = `${stamp} [pid:${process.pid}] ${level.padEnd(5)} ${tag} | ${body}\n`;

		if (error) {
			if (error instanceof Error) {
				line += `    caused by ${error.name}: ${error.message}\n`;
				if (error.stack) {
					const stackLines = error.stack.split('\n').slice(1, 9);
					line += stackLines.map(s => `      ${s.trim()}`).join('\n') + '\n';
				}
			} else {
				line += `    caused by: ${String(error)}\n`;
			}
		}

		const buf = Buffer.from(line, 'utf-8');
		fs.writeSync(this.fd, buf, 0, buf.length, null);
		this.writtenBytes += buf.length;
	}

	private rotate(): void {
		try {
			if (this.fd !== null) {
				fs.closeSync(this.fd);
				this.fd = null;
			}
			for (let i = MAX_BACKUPS; i >= 1; i--) {
				const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
				const dst = `${this.filePath}.${i}`;
				if (fs.existsSync(dst)) {
					try { fs.unlinkSync(dst); } catch { /* ignore */ }
				}
				if (fs.existsSync(src)) {
					try { fs.renameSync(src, dst); } catch { /* ignore */ }
				}
			}
			this.open();
		} catch {
			// best effort
		}
	}

	public close(): void {
		if (this.fd !== null) {
			try {
				fs.closeSync(this.fd);
			} catch { /* ignore */ }
			this.fd = null;
		}
	}
}
