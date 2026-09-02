/**
 * TokenTrackerHandler — port of cc-gui `handler/TokenTrackerHandler.java`.
 *
 * Bridges the vendored usage-dashboard to the locally-installed `tokentracker-cli`
 * npm package.  Four bridge commands:
 *   tt_detect_cli    → { installed, binPath?, version? }
 *   tt_install_cli   → { installed: true }
 *   tt_ensure_server → { running: true, port }
 *   tt_proxy         → { body } (raw JSON response text)
 *
 * All operations run asynchronously and answer via
 * `window.onTokenTrackerResponse({ requestId, ok, data|error })`.
 */
import { spawn, execFile } from 'child_process';
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import * as http from 'http';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const SUPPORTED_TYPES = ['tt_detect_cli', 'tt_install_cli', 'tt_ensure_server', 'tt_proxy'];

// ── Constants (mirrors Java TokenTrackerHandler) ──────────────────────────────

const CLI_BIN_NAMES = ['tokentracker', 'tracker', 'tokentracker-cli'];
const TT_CLI_PACKAGE = 'tokentracker-cli@0.87.3';
const TT_DEFAULT_PORT = 7680;
const TT_STATUS_SCAN_FIRST = 7680;
const TT_STATUS_SCAN_LAST = 7684;
const TT_ENSURE_PORT_FIRST = 7680;
const TT_ENSURE_PORT_LAST = 7690;
const TT_USER_STATUS_PATH = '/functions/tokentracker-user-status';
const TT_STATUS_TIMEOUT_MS = 2_000;
const TT_PROXY_TIMEOUT_MS = 30_000;
const TT_READY_TIMEOUT_MS = 30_000;
const TT_READY_POLL_INTERVAL_MS = 400;
const TT_VERSION_PROBE_TIMEOUT_SEC = 10;
const TT_INSTALL_TIMEOUT_SEC = 180;

const RESTRICTED_HEADERS = new Set([
	'host', 'content-length', 'connection', 'expect', 'upgrade',
]);

// ── State ────────────────────────────────────────────────────────────────────

/** Port of the server we started or last found running. */
let rememberedPort = 0;

/** Mutex to serialize detect+spawn so concurrent ensure calls cannot race. */
let ensureMutex: Promise<unknown> = Promise.resolve();

// ── Handler ──────────────────────────────────────────────────────────────────

export class TokenTrackerHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'tt_detect_cli':
				this.handleDetectCli(content);
				return true;
			case 'tt_install_cli':
				this.handleInstallCli(content);
				return true;
			case 'tt_ensure_server':
				this.handleEnsureServer(content);
				return true;
			case 'tt_proxy':
				this.handleProxy(content);
				return true;
			default:
				return false;
		}
	}

	// ── tt_detect_cli ──────────────────────────────────────────────────────

	private handleDetectCli(content: string): void {
		const requestId = parseRequestId(content);
		this.runAsync(requestId, async () => {
			const status = await this.detectCli();
			return status;
		});
	}

	// ── tt_install_cli ─────────────────────────────────────────────────────

	private handleInstallCli(content: string): void {
		const requestId = parseRequestId(content);
		this.runAsync(requestId, async () => {
			const npm = this.resolveNpmBin();
			const result = await runProcess(
				[npm, 'install', '-g', TT_CLI_PACKAGE],
				TT_INSTALL_TIMEOUT_SEC,
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`tokentracker-cli install failed with exit code ${result.exitCode}: ${outputSnippet(result.stdout)}`,
				);
			}
			return { installed: true };
		});
	}

	// ── tt_ensure_server ───────────────────────────────────────────────────

	private handleEnsureServer(content: string): void {
		const requestId = parseRequestId(content);
		// Serialize detect+spawn so concurrent ensure calls cannot race.
		const prev = ensureMutex;
		let release!: () => void;
		ensureMutex = new Promise<void>((r) => { release = r; });

		prev.then(async () => {
			try {
				await this.runEnsureServer(requestId);
			} finally {
				release();
			}
		});
	}

	private async runEnsureServer(requestId: string): Promise<void> {
		try {
			// 1. Check if already running
			const runningPort = await this.detectRunningServerPort();
			if (runningPort > 0) {
				this.respondOk(requestId, { running: true, port: runningPort });
				return;
			}

			// 2. Detect CLI
			const cli = await this.detectCli();
			if (!cli.installed || !cli.binPath) {
				throw new Error('tokentracker_cli_not_installed');
			}

			// 3. Find free port
			const port = await this.findFreePort();
			if (port < 0) {
				throw new Error(
					`No free port for tokentracker server (${TT_ENSURE_PORT_FIRST}-${TT_ENSURE_PORT_LAST})`,
				);
			}

			// 4. Spawn server
			this.spawnServer(cli.binPath, port);

			// 5. Await readiness
			await this.awaitServerReady(port);

			rememberedPort = port;
			this.respondOk(requestId, { running: true, port });
		} catch (err) {
			this.respondError(requestId, err instanceof Error ? err.message : String(err));
		}
	}

	// ── tt_proxy ───────────────────────────────────────────────────────────

	private handleProxy(content: string): void {
		const requestId = parseRequestId(content);
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(content);
		} catch {
			this.respondError(requestId, 'tokentracker proxy: invalid request payload');
			return;
		}

		this.runAsync(requestId, async () => {
			const method = (typeof payload.method === 'string' ? payload.method : 'GET').toUpperCase();
			const path = typeof payload.path === 'string' ? payload.path : '';
			const body = typeof payload.body === 'string' ? payload.body : null;
			const headers = (payload.headers && typeof payload.headers === 'object')
				? payload.headers as Record<string, string>
				: {};

			const pathOnly = path.split('?')[0];
			if (!pathOnly.startsWith('/functions/tokentracker-') && pathOnly !== '/api/local-auth') {
				throw new Error('tokentracker proxy path not allowed: ' + path);
			}
			if (method !== 'GET' && method !== 'POST') {
				throw new Error('tokentracker proxy method not allowed: ' + method);
			}

			const port = rememberedPort > 0 ? rememberedPort : TT_DEFAULT_PORT;
			const responseBody = await proxyHttpRequest(method, port, path, headers, body);
			return { body: responseBody };
		});
	}

	// ── CLI detection ──────────────────────────────────────────────────────

	private async detectCli(): Promise<{ installed: boolean; binPath?: string; version?: string }> {
		const candidates = this.cliCandidates();
		for (const candidate of candidates) {
			const version = await this.probeCliVersion(candidate);
			if (version !== null) {
				return { installed: true, binPath: candidate, version };
			}
		}
		return { installed: false };
	}

	private cliCandidates(): string[] {
		const candidates = new Set<string>();
		const home = process.env.HOME || process.env.USERPROFILE || '';

		// Well-known npm global bin directories
		const binDirs: string[] = [];
		if (process.platform === 'win32') {
			const appData = process.env.APPDATA;
			if (appData) {
				binDirs.push(join(appData, 'npm'));
			}
		} else {
			binDirs.push('/usr/local/bin');
			binDirs.push('/opt/homebrew/bin');
			binDirs.push('/usr/bin');
			if (home) {
				binDirs.push(join(home, '.npm-global', 'bin'));
				binDirs.push(join(home, '.hermes', 'node', 'bin'));
				binDirs.push(join(home, '.volta', 'bin'));
				binDirs.push(join(home, '.fnm', 'aliases', 'default', 'bin'));
				binDirs.push(join(home, '.nvmd', 'bin'));
				// nvm: scan version dirs, newest first
				const nvmNodeDir = join(home, '.nvm', 'versions', 'node');
				if (existsSync(nvmNodeDir)) {
					try {
						const { readdirSync } = require('fs');
						const dirs = readdirSync(nvmNodeDir)
							.filter((d: string) => {
								try { return statSync(join(nvmNodeDir, d)).isDirectory(); } catch { return false; }
							})
							.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
						for (const d of dirs) {
							binDirs.push(join(nvmNodeDir, d, 'bin'));
						}
					} catch { /* ignore */ }
				}
			}
		}
		// Node's own bin dir
		const nodeBinDir = this.nodeBinDir();
		if (nodeBinDir) {
			binDirs.push(nodeBinDir);
		}

		const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];

		// Scan well-known directories
		for (const dir of binDirs) {
			for (const name of CLI_BIN_NAMES) {
				for (const ext of extensions) {
					const filePath = join(dir, name + ext);
					if (fileExists(filePath)) {
						candidates.add(filePath);
					}
				}
			}
		}
		// Bare names — resolved through PATH by the OS
		for (const name of CLI_BIN_NAMES) {
			for (const ext of extensions) {
				candidates.add(name + ext);
			}
		}

		return [...candidates];
	}

	private nodeBinDir(): string | null {
		// Derive from process.execPath (e.g. /usr/local/bin/node → /usr/local/bin)
		const execDir = process.execPath;
		if (execDir) {
			const dir = join(execDir, '..');
			if (existsSync(dir)) {
				return dir;
			}
		}
		return null;
	}

	private async probeCliVersion(bin: string): Promise<string | null> {
		try {
			const result = await runProcess([bin, '--version'], TT_VERSION_PROBE_TIMEOUT_SEC);
			if (result.exitCode === 0 && result.stdout.trim()) {
				const firstLine = result.stdout.split('\n')[0]?.trim() || '';
				return firstLine || 'unknown';
			}
		} catch {
			// Ignore — candidate not available
		}
		return null;
	}

	private resolveNpmBin(): string {
		// Try to find npm next to node
		const nodeExecDir = this.nodeBinDir();
		if (nodeExecDir) {
			const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
			const npmPath = join(nodeExecDir, npmName);
			if (fileExists(npmPath)) {
				return npmPath;
			}
		}
		return process.platform === 'win32' ? 'npm.cmd' : 'npm';
	}

	// ── Server lifecycle ───────────────────────────────────────────────────

	private async detectRunningServerPort(): Promise<number> {
		if (rememberedPort > 0 && (await this.probeServerOnPort(rememberedPort))) {
			return rememberedPort;
		}
		for (let port = TT_STATUS_SCAN_FIRST; port <= TT_STATUS_SCAN_LAST; port++) {
			if (await this.probeServerOnPort(port)) {
				rememberedPort = port;
				return port;
			}
		}
		return -1;
	}

	private async probeServerOnPort(port: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const req = http.get(
				`http://127.0.0.1:${port}${TT_USER_STATUS_PATH}`,
				{ timeout: TT_STATUS_TIMEOUT_MS },
				(res) => {
					res.resume();
					resolve(res.statusCode === 200);
				},
			);
			req.on('error', () => resolve(false));
			req.on('timeout', () => { req.destroy(); resolve(false); });
		});
	}

	private async findFreePort(): Promise<number> {
		return new Promise<number>((resolve) => {
			const net = require('net');
			const tryPort = (port: number) => {
				if (port > TT_ENSURE_PORT_LAST) {
					resolve(-1);
					return;
				}
				const server = net.createServer();
				server.once('error', () => tryPort(port + 1));
				server.once('listening', () => {
					server.close(() => resolve(port));
				});
				server.listen(port, '127.0.0.1');
			};
			tryPort(TT_ENSURE_PORT_FIRST);
		});
	}

	private spawnServer(bin: string, port: number): void {
		try {
			const isWin = process.platform === 'win32';
			const isCmdShim = isWin && /\.(cmd|bat)$/i.test(String(bin || ''));
			const child = spawn(bin, ['serve', '--no-open', '--port', String(port)], {
				detached: !isWin,
				stdio: 'ignore',
				shell: isCmdShim,
				windowsHide: true,
				env: {
					...process.env,
					TOKENTRACKER_NO_TELEMETRY: '1',
				},
			});
			child.unref();
			console.log(`[TokenTrackerHandler] Started tokentracker server on port ${port}`);
		} catch (err) {
			throw new Error(
				`Failed to start tokentracker server: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async awaitServerReady(port: number): Promise<void> {
		const deadline = Date.now() + TT_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await this.probeServerOnPort(port)) {
				return;
			}
			await sleep(TT_READY_POLL_INTERVAL_MS);
		}
		throw new Error(
			`tokentracker server did not become ready on port ${port} within ${TT_READY_TIMEOUT_MS / 1000}s`
			+ ' (the port may have been taken by another process)',
		);
	}

	// ── Plumbing ───────────────────────────────────────────────────────────

	private runAsync(requestId: string, fn: () => Promise<Record<string, unknown>>): void {
		fn()
			.then((data) => this.respondOk(requestId, data))
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[TokenTrackerHandler] ${msg}`);
				this.respondError(requestId, msg);
			});
	}

	private respondOk(requestId: string, data: Record<string, unknown>): void {
		this.callJavaScript(
			'onTokenTrackerResponse',
			JSON.stringify({ requestId, ok: true, data }),
		);
	}

	private respondError(requestId: string, message: string): void {
		this.callJavaScript(
			'onTokenTrackerResponse',
			JSON.stringify({ requestId, ok: false, error: message || 'unknown error' }),
		);
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseRequestId(content: string): string {
	try {
		const json = JSON.parse(content);
		if (json.requestId && typeof json.requestId === 'string') {
			return json.requestId;
		}
	} catch { /* ignore */ }
	return '';
}

function fileExists(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputSnippet(stdout: string): string {
	const trimmed = stdout.trim();
	return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
}

function runProcess(command: string[], timeoutSec: number): Promise<ProcessResult> {
	return new Promise<ProcessResult>((resolve, reject) => {
		const [cmd, ...args] = command;
		const isCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(cmd || ''));
		const child = execFile(cmd, args, {
			timeout: timeoutSec * 1000,
			maxBuffer: 1024 * 1024,
			encoding: 'utf-8',
			shell: isCmdShim,
			windowsHide: true,
		}, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new Error(`Command not found: ${cmd}`));
				return;
			}
			// execFile calls back even on non-zero exit — that's fine
			resolve({
				exitCode: error ? (error as any).code ?? 1 : 0,
				stdout: stdout || '',
			});
		});
		// Kill on timeout (execFile handles this, but belt-and-suspenders)
	 setTimeout(() => {
			try { child.kill(); } catch { /* ignore */ }
		}, (timeoutSec + 5) * 1000);
	});
}

function proxyHttpRequest(
	method: string,
	port: number,
	path: string,
	headers: Record<string, string>,
	body: string | null,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reqHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (!RESTRICTED_HEADERS.has(key.toLowerCase()) && value != null) {
				reqHeaders[key] = value;
			}
		}

		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path,
				method,
				headers: reqHeaders,
				timeout: TT_PROXY_TIMEOUT_MS,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf-8');
					if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
						const snippet = text.length > 500 ? text.slice(0, 500) : text;
						reject(new Error(
							`tokentracker server returned HTTP ${res.statusCode}: ${snippet}`,
						));
						return;
					}
					resolve(text);
				});
			},
		);

		req.on('error', (err) => {
			reject(new Error('tokentracker server unreachable: ' + err.message));
		});
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('tokentracker proxy request timed out'));
		});

		if (method === 'POST' && body != null) {
			req.write(body);
		}
		req.end();
	});
}
