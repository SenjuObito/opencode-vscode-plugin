/**
 * OpenCodeDaemonBridge.ts
 *
 * TS 重写 of cc-gui `provider/common/DaemonBridge.java` — 管理常驻的
 * ai-bridge daemon 进程（NDJSON over stdio），对齐 Claude Code 的
 * 「常驻进程复用」模型，替代 cc-gui 里 opencode 的 per-process 拉起。
 *
 * 协议（与 daemon.js 一致）：
 *   宿主 → daemon：`{id, method, params}`（一行 NDJSON）
 *   daemon → 宿主：`{id, line}` 输出行 / `{id, done, success, error}` 完成
 *                  / `{id, type:'heartbeat'}` 心跳应答 / `{type:'daemon', event, ...}` 生命周期事件
 *
 * 生命周期：preconnect 预热 → 心跳 15s/超时 45s（活跃请求 180s）→ 崩溃重启 ≤3 次
 * （30s 稳定窗口后重置计数）。abort 绕过命令队列立即下发。
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';

const DAEMON_START_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000; // 空闲态 3 次心跳 = 死
const ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000;
const HEARTBEAT_PROBE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2;
const HEARTBEAT_SCHEDULER_GAP_MS = HEARTBEAT_INTERVAL_MS + 5_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 30_000;
const STDERR_RING_CAPACITY = 40;

export interface DaemonOutputCallback {
	onLine(line: string): void;
	onStderr?(text: string): void;
	onError(error: string): void;
	onComplete(success: boolean): void;
	/** 用户主动中断时调用，默认按 onComplete(false) 处理（非错误）。 */
	onAbort?(): void;
}

export interface DaemonLifecycleListener {
	onDaemonReady(): void;
	onDaemonDied(): void;
}

export interface DaemonEventListener {
	onDaemonEvent(event: string, data: Record<string, unknown>): void;
}

interface PendingRequest {
	callback: DaemonOutputCallback;
	countsAsActive: boolean;
}

enum DaemonState {
	ACTIVE = 'ACTIVE',
	DEATH_CLAIMED = 'DEATH_CLAIMED',
	STOPPED = 'STOPPED',
}

/** 单代进程所拥有的全部状态 —— 重启后旧代状态一律不可见。 */
class DaemonGeneration {
	readonly process: ChildProcess;
	readonly generation: number;
	readonly startedAtWallTimeMs: number;
	readonly startedAtNanos: number;
	readonly stderrRing: string[] = [];
	state: DaemonState = DaemonState.ACTIVE;
	startupPublished = false;
	readySignaled = false;
	// 心跳/活动时间戳（双时钟，wall + monotonic，跨挂起语义一致）
	lastHeartbeatWallTimeMs: number;
	lastHeartbeatNanos: number;
	lastActivityWallTimeMs: number;
	lastActivityNanos: number;
	heartbeatVersion = 0;
	activityVersion = 0;
	// 请求注册表
	readonly pendingRequests = new Map<string, PendingRequest>();
	activeRequestCount = 0;
	// 读线程/心跳定时器句柄（便于 stop 时清理）
	heartbeatTimer: NodeJS.Timeout | null = null;

	constructor(process: ChildProcess, generation: number, nowWall: number, nowNanos: number) {
		this.process = process;
		this.generation = generation;
		this.startedAtWallTimeMs = nowWall;
		this.startedAtNanos = nowNanos;
		this.lastHeartbeatWallTimeMs = nowWall;
		this.lastHeartbeatNanos = nowNanos;
		this.lastActivityWallTimeMs = nowWall;
		this.lastActivityNanos = nowNanos;
	}

	get isActive(): boolean {
		return this.state === DaemonState.ACTIVE;
	}

	get isStopped(): boolean {
		return this.state === DaemonState.STOPPED;
	}

	markHeartbeat(nowWall: number, nowNanos: number): void {
		this.lastHeartbeatWallTimeMs = nowWall;
		this.lastHeartbeatNanos = nowNanos;
		this.lastActivityWallTimeMs = nowWall;
		this.lastActivityNanos = nowNanos;
		this.heartbeatVersion++;
		this.activityVersion++;
	}

	markActivity(nowWall: number, nowNanos: number): void {
		this.lastActivityWallTimeMs = nowWall;
		this.lastActivityNanos = nowNanos;
		this.activityVersion++;
	}

	signalReady(): boolean {
		if (!this.isActive) {
			return false;
		}
		this.readySignaled = true;
		return true;
	}

	claimDeath(): void {
		if (this.state === DaemonState.ACTIVE) {
			this.state = DaemonState.DEATH_CLAIMED;
		}
	}

	stop(): void {
		this.state = DaemonState.STOPPED;
	}

	appendStderr(line: string): void {
		this.stderrRing.push(line);
		while (this.stderrRing.length > STDERR_RING_CAPACITY) {
			this.stderrRing.shift();
		}
	}

	formatStderrTail(): string {
		return this.stderrRing.length === 0 ? 'stderr=(empty)' : 'stderrTail=' + this.stderrRing.join(' | ');
	}

	registerRequest(id: string, handler: PendingRequest): boolean {
		if (!this.isActive) {
			return false;
		}
		this.pendingRequests.set(id, handler);
		if (handler.countsAsActive) {
			this.activeRequestCount++;
		}
		return true;
	}

	removeRequest(id: string): void {
		const removed = this.pendingRequests.get(id);
		if (removed?.countsAsActive) {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
		}
		this.pendingRequests.delete(id);
	}

	drainRequests(): PendingRequest[] {
		const handlers = [...this.pendingRequests.values()];
		this.pendingRequests.clear();
		this.activeRequestCount = 0;
		return handlers;
	}

	/** 捕获一次心跳观测（版本号 + 年龄）。 */
	snapshot(nowWall: number, nowNanos: number): HeartbeatObservation {
		return {
			nowWallTimeMs: nowWall,
			nowNanos,
			heartbeatWallAgeMs: Math.max(0, nowWall - this.lastHeartbeatWallTimeMs),
			activityWallAgeMs: Math.max(0, nowWall - this.lastActivityWallTimeMs),
			heartbeatMonotonicAgeMs: Math.max(0, nowNanos - this.lastHeartbeatNanos),
			activityMonotonicAgeMs: Math.max(0, nowNanos - this.lastActivityNanos),
			heartbeatVersion: this.heartbeatVersion,
			activityVersion: this.activityVersion,
			activeRequestCount: this.activeRequestCount,
		};
	}
}

interface HeartbeatObservation {
	nowWallTimeMs: number;
	nowNanos: number;
	heartbeatWallAgeMs: number;
	activityWallAgeMs: number;
	heartbeatMonotonicAgeMs: number;
	activityMonotonicAgeMs: number;
	heartbeatVersion: number;
	activityVersion: number;
	activeRequestCount: number;
}

type HeartbeatDecision = 'HEALTHY' | 'SEND_PROBE' | 'WAIT_FOR_PROBE' | 'DECLARE_DEAD';

/**
 * 空闲态先探测后重启（对齐 Java IdleHeartbeatProbeState）：只有心跳停滞超过
 * 阈值才先发一次探测心跳，避免假死误杀；活跃请求保持 180s 语义。
 */
class HeartbeatProbeState {
	private lastCheckWallTimeMs = -1;
	private probeActive = false;
	private probeStartedAtNanos = 0;
	private probeHeartbeatVersion = -1;

	evaluate(obs: HeartbeatObservation): HeartbeatDecision {
		const nowWall = obs.nowWallTimeMs;
		const schedulerDiscontinuity =
			this.lastCheckWallTimeMs >= 0 &&
			(nowWall < this.lastCheckWallTimeMs || nowWall - this.lastCheckWallTimeMs > HEARTBEAT_SCHEDULER_GAP_MS);
		this.lastCheckWallTimeMs = nowWall;

		// 活跃请求：沿用既有语义，探测心跳不足以证明挂起中的 SDK 网络操作恢复。
		if (obs.activeRequestCount > 0) {
			this.probeActive = false;
			const livenessAge = Math.min(obs.heartbeatWallAgeMs, obs.activityWallAgeMs);
			return livenessAge > ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS ? 'DECLARE_DEAD' : 'HEALTHY';
		}

		// 任何平台的 wall-clock 调度跳跃都会武装空闲探测。
		if (schedulerDiscontinuity) {
			this.startProbe(obs.nowNanos, obs.heartbeatVersion);
			return 'SEND_PROBE';
		}

		if (this.probeActive) {
			if (obs.heartbeatVersion !== this.probeHeartbeatVersion) {
				this.probeActive = false;
				return 'HEALTHY';
			}
			if (obs.nowNanos - this.probeStartedAtNanos < HEARTBEAT_PROBE_TIMEOUT_MS) {
				return 'WAIT_FOR_PROBE';
			}
			return 'DECLARE_DEAD';
		}

		if (Math.min(obs.heartbeatMonotonicAgeMs, obs.activityMonotonicAgeMs) <= HEARTBEAT_TIMEOUT_MS) {
			return 'HEALTHY';
		}

		this.startProbe(obs.nowNanos, obs.heartbeatVersion);
		return 'SEND_PROBE';
	}

	reset(nowWall: number): void {
		this.lastCheckWallTimeMs = nowWall;
		this.probeActive = false;
	}

	private startProbe(nowNanos: number, heartbeatVersion: number): void {
		this.probeStartedAtNanos = nowNanos;
		this.probeHeartbeatVersion = heartbeatVersion;
		this.probeActive = true;
	}
}

function shouldAutoRestart(
	desiredRunning: boolean,
	currentStopEpoch: number,
	claimedStopEpoch: number,
	currentContext: DaemonGeneration | null,
	claimedContext: DaemonGeneration,
	attempts: number,
): boolean {
	return (
		desiredRunning &&
		currentStopEpoch === claimedStopEpoch &&
		currentContext === claimedContext &&
		!claimedContext.isStopped &&
		attempts <= MAX_RESTART_ATTEMPTS
	);
}

export interface OpenCodeDaemonBridgeOptions {
	/** 要 spawn 的 daemon 脚本绝对路径（daemon.js）。 */
	daemonScriptPath: string;
	/** daemon 工作目录（ai-bridge 目录，用于解析 node_modules）。 */
	cwd?: string;
	/** 可选生命周期监听。 */
	lifecycleListener?: DaemonLifecycleListener;
	onLog?: (message: string) => void;
	/** spawn daemon 时叠加的额外环境变量（如用户自定义的 OPENCODE_BIN）。 */
	additionalEnv?: () => Record<string, string | undefined>;
}

export class OpenCodeDaemonBridge {
	private readonly daemonScriptPath: string;
	private readonly cwd: string;
	private readonly lifecycleListener?: DaemonLifecycleListener;
	private readonly onLog?: (message: string) => void;
	private readonly additionalEnv?: () => Record<string, string | undefined>;
	private readonly eventListeners = new Set<DaemonEventListener>();

	private daemonContext: DaemonGeneration | null = null;
	private generationCounter = 0;
	private requestIdCounter = 0;
	private restartAttempts = 0;
	private desiredRunning = false;
	private stopEpoch = 0;
	private restartInProgress = false;

	constructor(options: OpenCodeDaemonBridgeOptions) {
		this.daemonScriptPath = options.daemonScriptPath;
		this.cwd = options.cwd ?? require('path').dirname(options.daemonScriptPath);
		this.lifecycleListener = options.lifecycleListener;
		this.onLog = options.onLog;
		this.additionalEnv = options.additionalEnv;
	}

	private log(message: string): void {
		this.onLog?.(`[OpenCodeDaemonBridge] ${message}`);
	}

	// =========================================================================
	// 生命周期
	// =========================================================================

	/** 启动 daemon 并阻塞等待 ready（≤30s）。返回是否成功。 */
	start(): Promise<boolean> {
		if (this.daemonContext?.isActive && this.daemonContext.process.exitCode === null && this.daemonContext.readySignaled) {
			this.log('Daemon already running');
			return Promise.resolve(true);
		}
		if (this.restartInProgress) {
			this.log('Daemon restart cleanup still in progress');
			return Promise.resolve(false);
		}
		this.desiredRunning = true;
		return this.executeStartAttempt();
	}

	private async executeStartAttempt(): Promise<boolean> {
		this.log(`Starting daemon (attempt restartAttempts=${this.restartAttempts})`);
		const startedProcess = this.launchProcess();
		const generation = ++this.generationCounter;
		const nowWall = Date.now();
		const nowNanos = performance.now();
		const context = new DaemonGeneration(startedProcess, generation, nowWall, nowNanos);
		this.daemonContext = context;

		this.startReader(context);
		this.startStderrReader(context);

		const ready = await this.awaitDaemonReady(context);
		if (!ready) {
			this.log(`Daemon failed to signal ready: ${context.formatStderrTail()}`);
			this.failStartAttempt(context);
			return false;
		}

		context.startupPublished = true;
		this.startHeartbeat(context);
		this.log(`Daemon is ready. PID=${startedProcess.pid}, generation=${generation}`);
		this.lifecycleListener?.onDaemonReady();
		return true;
	}

	private launchProcess(): ChildProcess {
		if (!fs.existsSync(this.daemonScriptPath)) {
			throw new Error(`daemon.js not found at: ${this.daemonScriptPath}`);
		}
		this.log(`Launching: ${process.execPath} ${this.daemonScriptPath} (cwd=${this.cwd})`);
		const extraEnv = this.additionalEnv?.() ?? {};
		const extraEnvEntries = Object.entries(extraEnv).filter(([, v]) => v !== undefined && v !== '');
		if (extraEnvEntries.length > 0) {
			this.log(`Extra env: ${extraEnvEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
		}
		const child = spawn(process.execPath, [this.daemonScriptPath], {
			cwd: this.cwd,
			env: { ...process.env, ...extraEnv },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		child.on('exit', () => {
			// 由 reader 的 EOF 统一走 handleDaemonDeath（保留一次语义）
		});
		return child;
	}

	private async awaitDaemonReady(context: DaemonGeneration): Promise<boolean> {
		const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (context.readySignaled) {
				return context.isActive && context.process.exitCode === null;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return false;
	}

	private failStartAttempt(context: DaemonGeneration): void {
		if (!context.startupPublished) {
			context.stop();
		}
		this.desiredRunning = false;
		this.destroyProcess(context.process);
	}

	private destroyProcess(process: ChildProcess | null | undefined): void {
		if (process && process.exitCode === null) {
			try {
				process.kill('SIGKILL');
			} catch {
				/* 已退出 */
			}
		}
	}

	/** 优雅停止：取消挂起请求、发 shutdown、关 stdin、强杀。 */
	stop(): void {
		this.log('Stopping daemon...');
		this.desiredRunning = false;
		this.stopEpoch++;
		const context = this.daemonContext;
		if (!context) {
			return;
		}
		context.stop();

		for (const handler of context.drainRequests()) {
			handler.callback.onError('Daemon stopped');
		}

		if (context.heartbeatTimer) {
			clearInterval(context.heartbeatTimer);
			context.heartbeatTimer = null;
		}

		if (context.process.exitCode === null) {
			try {
				context.process.stdin?.write(JSON.stringify({ id: 'shutdown', method: 'shutdown' }) + '\n');
			} catch {
				/* daemon 已死 */
			}
			try {
				context.process.stdin?.end();
			} catch {
				/* ignore */
			}
			setTimeout(() => this.destroyProcess(context.process), 100);
		}

		this.log('Daemon stopped');
	}

	/** 发送 abort（绕过命令队列立即下发），并完成所有挂起请求。 */
	sendAbort(): void {
		const context = this.daemonContext;
		if (context?.isActive && context.process.exitCode === null) {
			try {
				context.process.stdin?.write(
					JSON.stringify({ id: `abort-${Date.now()}`, method: 'abort' }) + '\n',
				);
				this.log('Sent abort command');
			} catch {
				/* ignore */
			}
		}
		// 用 onComplete(false) 而非 onError —— 用户主动中断是正常（未成功）完成。
		if (context) {
			for (const handler of context.drainRequests()) {
				// 注意：不能写 `onAbort?.() ?? onComplete(false)` —— onAbort 返回
				// undefined，`??` 会使两个回调都被执行，onComplete(false) 会把
				// 用户主动中断误报为「发送失败」错误。
				if (handler.callback.onAbort) {
					handler.callback.onAbort();
				} else {
					handler.callback.onComplete(false);
				}
			}
		}
	}

	isAlive(): boolean {
		const context = this.daemonContext;
		return (
			context !== null &&
			context.startupPublished &&
			context.isActive &&
			context.process.exitCode === null
		);
	}

	async ensureRunning(): Promise<boolean> {
		return this.isAlive() ? true : this.start();
	}

	addEventListener(listener: DaemonEventListener): void {
		this.eventListeners.add(listener);
	}

	removeEventListener(listener: DaemonEventListener): void {
		this.eventListeners.delete(listener);
	}

	// =========================================================================
	// 请求执行
	// =========================================================================

	/**
	 * 向 daemon 发送命令并以回调接收输出行。非阻塞；future 由 done 信号完成。
	 */
	async request(
		method: string,
		params: Record<string, unknown>,
		callback: DaemonOutputCallback,
	): Promise<boolean> {
		if (!(await this.ensureRunning())) {
			callback.onError('Daemon not running');
			return false;
		}
		const context = this.daemonContext;
		if (!context?.isActive || context.process.exitCode !== null) {
			callback.onError('Daemon generation changed before request');
			return false;
		}

		const requestId = String(++this.requestIdCounter);
		const countsAsActive = method !== 'heartbeat' && method !== 'status';
		const handler: PendingRequest = { callback, countsAsActive };
		if (!context.registerRequest(requestId, handler)) {
			callback.onError('Daemon generation is no longer active');
			return false;
		}

		const request = JSON.stringify({ id: requestId, method, params });
		try {
			context.process.stdin?.write(request + '\n');
			this.log(`Sent request ${requestId}: ${method}`);
		} catch (err) {
			context.removeRequest(requestId);
			callback.onError(`Failed to send request: ${(err as Error).message}`);
			return false;
		}
		return true;
	}

	// =========================================================================
	// 读线程
	// =========================================================================

	private startReader(context: DaemonGeneration): void {
		const rl = readline.createInterface({ input: context.process.stdout! });
		rl.on('line', (line) => {
			if (!this.isCurrent(context) || !context.isActive) {
				return;
			}
			this.handleDaemonOutput(line, context);
		});
		rl.on('close', () => {
			if (this.isCurrent(context) && context.isActive) {
				this.handleDaemonDeath(context);
			}
		});
	}

	private startStderrReader(context: DaemonGeneration): void {
		const rl = readline.createInterface({ input: context.process.stderr! });
		rl.on('line', (line) => {
			if (this.isCurrent(context) && context.isActive) {
				context.appendStderr(line);
				this.log(`[daemon:stderr] ${line}`);
			}
		});
	}

	private startHeartbeat(context: DaemonGeneration): void {
		const probeState = new HeartbeatProbeState();
		probeState.reset(Date.now());

		context.heartbeatTimer = setInterval(() => {
			if (!context.isActive || !this.isCurrent(context)) {
				return;
			}
			if (context.process.exitCode !== null) {
				this.handleDaemonDeath(context);
				return;
			}

			const nowWall = Date.now();
			const nowNanos = performance.now();
			const obs = context.snapshot(nowWall, nowNanos);
			const decision = probeState.evaluate(obs);
			if (decision === 'DECLARE_DEAD') {
				this.log(
					`Daemon unresponsive (activeRequests=${obs.activeRequestCount}, generation=${context.generation}), treating as dead`,
				);
				this.handleDaemonDeath(context);
				return;
			}
			if (decision === 'WAIT_FOR_PROBE') {
				return;
			}
			if (decision === 'SEND_PROBE') {
				this.log(`Daemon heartbeat stale; sending resume-safe probe (activeRequests=${obs.activeRequestCount})`);
			}

			try {
				context.process.stdin?.write(
					JSON.stringify({ id: `hb-${nowWall}`, method: 'heartbeat' }) + '\n',
				);
			} catch {
				this.handleDaemonDeath(context);
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	// =========================================================================
	// 输出解析
	// =========================================================================

	private handleDaemonOutput(line: string, context: DaemonGeneration): void {
		const trimmed = line.trim();
		if (!trimmed || trimmed.charAt(0) !== '{') {
			this.log(`[daemon] Non-JSON output: ${trimmed}`);
			return;
		}
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			this.log(`[daemon] Failed to parse output: ${trimmed}`);
			return;
		}

		// daemon 生命周期/心跳/状态事件（无 id 或 type 优先）
		const type = obj.type as string | undefined;
		if (type === 'daemon') {
			this.handleDaemonEvent(obj, context);
			return;
		}
		if (type === 'heartbeat') {
			context.markHeartbeat(Date.now(), performance.now());
			return;
		}
		if (type === 'status') {
			return;
		}

		const id = obj.id as string | undefined;
		if (!id || id.startsWith('hb-')) {
			return;
		}

		const pending = context.pendingRequests.get(id);
		if (!pending) {
			return;
		}

		if (obj.done !== undefined) {
			const success = obj.success === true;
			if (!success && typeof obj.error === 'string') {
				pending.callback.onError(obj.error);
			}
			pending.callback.onComplete(success);
			context.removeRequest(id);
			return;
		}

		if (typeof obj.line === 'string') {
			pending.callback.onLine(obj.line);
			return;
		}

		if (typeof obj.stderr === 'string') {
			pending.callback.onStderr?.(obj.stderr);
		}
	}

	private handleDaemonEvent(
		obj: Record<string, unknown>,
		context: DaemonGeneration,
	): void {
		const event = (obj.event as string | undefined) ?? 'unknown';
		const message = typeof obj.message === 'string' ? obj.message : undefined;
		if (message) {
			this.log(`[daemon:${event}] ${message}`);
		} else {
			this.log(`Daemon event: ${event}`);
		}
		switch (event) {
			case 'ready': {
				if (context.signalReady()) {
					this.lifecycleListener?.onDaemonReady();
				}
				break;
			}
			case 'startup_failed':
				this.log(`Daemon reported startup_failed: ${String(obj.error ?? 'unknown')}`);
				break;
			case 'shutdown':
				this.log('Daemon shutting down');
				break;
			default:
				for (const listener of this.eventListeners) {
					try {
						listener.onDaemonEvent(event, obj);
					} catch (err) {
						this.log(`Listener threw while handling ${event}: ${(err as Error).message}`);
					}
				}
		}
	}

	// =========================================================================
	// daemon 死亡 & 自动重启
	// =========================================================================

	private handleDaemonDeath(context: DaemonGeneration): void {
		if (!this.isCurrent(context) || !context.isActive || !this.desiredRunning || this.restartInProgress) {
			this.log(`Ignoring stale death signal for generation=${context.generation}`);
			return;
		}
		this.restartInProgress = true;
		context.claimDeath();
		const claimedStopEpoch = this.stopEpoch;
		const failedHandlers = context.drainRequests();

		this.log(`Daemon process died, generation=${context.generation}`);
		this.destroyProcess(context.process);

		for (const handler of failedHandlers) {
			handler.callback.onError('Daemon process died unexpectedly');
		}
		this.lifecycleListener?.onDaemonDied();

		if (context.heartbeatTimer) {
			clearInterval(context.heartbeatTimer);
			context.heartbeatTimer = null;
		}

		if (!context.startupPublished) {
			this.restartInProgress = false;
			this.desiredRunning = false;
			this.log('Initial daemon exited before ready; background restart disabled until start() called again');
			return;
		}

		const uptime = Math.max(0, Date.now() - context.startedAtWallTimeMs);
		if (uptime > RESTART_WINDOW_MS) {
			this.restartAttempts = 0;
		}
		const attempts = ++this.restartAttempts;

		this.restartInProgress = false;
		const shouldRestart = shouldAutoRestart(
			this.desiredRunning,
			this.stopEpoch,
			claimedStopEpoch,
			this.daemonContext,
			context,
			attempts,
		);
		if (shouldRestart) {
			this.log(`Attempting restart (${attempts}/${MAX_RESTART_ATTEMPTS}, last uptime=${uptime}ms)`);
			void this.executeStartAttempt();
		} else {
			this.log(`Max restart attempts reached (${attempts} within ${RESTART_WINDOW_MS}ms window)`);
		}
	}

	private isCurrent(context: DaemonGeneration): boolean {
		return this.daemonContext === context;
	}
}
