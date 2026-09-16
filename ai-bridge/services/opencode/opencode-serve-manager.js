/**
 * opencode-serve-manager.js
 *
 * Manages the lifecycle of the `opencode serve` process for the persistent
 * (daemon) bridge. On demand it finds the opencode binary and spawns
 * `opencode serve --port <port>`; `stop()` kills it gracefully.
 *
 * Cross-platform: Windows (.cmd shims via shell), macOS, and Linux.
 * Binary resolution is delegated to cli-path.js (resolveOpenCodeCliPath).
 */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import {
  resolveOpenCodeCliPath,
  needsShellOnWindows,
  commonCliBinDirs,
  enrichPathWithBinDirs,
} from '../../utils/cli-path.js';

/** @type {cp.ChildProcess | null} */
let _process = null;
let _serverUrl = null;
/** @type {Promise<string> | null} */
let _startPromise = null;
/** Last port passed to start(), so an auto-restart rebinds the same port the
 *  daemon originally requested (the daemon may override via OPENCODE_PORT env). */
let _lastPort = 4096;
/** True once serve has been started or reused successfully. Distinguishes a
 *  steady-state crash (auto-restart) from a failure during initial boot
 *  (which must surface to the caller instead of retrying forever). */
let _started = false;
/** Set while stop() is in progress so an exit event is treated as an expected
 *  shutdown rather than a crash to recover from. */
let _stopRequested = false;
/** Auto-restart backoff bookkeeping. */
let _restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10000;

/**
 * @returns {string | null} The URL the server was started on, if any.
 */
export function getServerUrl() {
  return _serverUrl;
}

/**
 * @returns {cp.ChildProcess | null} The running serve child process (test/debug hook).
 */
export function getServeProcess() {
  return _process;
}

/**
 * Check if a file exists (cross-platform).
 * On Windows X_OK is unreliable; F_OK is sufficient.
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search for the opencode binary using cross-platform resolution.
 *
 * Priority (via cli-path.js resolveOpenCodeCliPath):
 *   0. OPENCODE_BIN / OPENCODE_PATH / OPENCODE_CLI_PATH env vars
 *   1. PATH lookup (where.exe on Windows, which on Unix)
 *   2. ~/.opencode/bin/opencode
 *   3. ~/.local/bin/opencode
 *   4. ~/.local/share/opencode/bin/opencode
 *
 * On Windows, npm global installs create .cmd shims which are
 * automatically resolved by cli-path.js.
 *
 * @returns {Promise<string | null>} Absolute path, or null if not found.
 */
export async function findBinary() {
  const resolved = resolveOpenCodeCliPath();
  if (!resolved) return null;
  // Bare command name (no path, no drive): cannot F_OK-check against cwd.
  // Let it through to spawn, where needsShellOnWindows forces a shell on
  // Windows so cmd/PATHEXT resolves the real .exe/.cmd.
  if (!/[\\/]/.test(resolved) && !/^[A-Za-z]:/.test(resolved)) {
    return resolved;
  }
  return isExecutable(resolved) ? resolved : null;
}

/**
 * Poll the server URL until it responds or the timeout elapses.
 * Checks every 300ms with a 2s per-request connect timeout.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForReady(url, timeoutMs) {
  const start = Date.now();

  const poll = () => new Promise((resolve) => {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      resolve(false);
      return;
    }

    const req = http.get(url, (res) => {
      // Any HTTP response (including 404) means the server is listening
      res.resume(); // consume response body
      resolve(true);
    });

    req.on('error', () => {
      // Connection refused or similar — not ready yet
      setTimeout(() => resolve(poll()), 300);
    });

    req.setTimeout(2000, () => {
      req.destroy();
      setTimeout(() => resolve(poll()), 300);
    });
  });

  return poll();
}

/**
 * Spawn `opencode serve --port <port>` and wait for it to be ready.
 *
 * Idempotent: if a server is already running on the requested port, the
 * existing URL is returned.
 *
 * @param {number} [port] TCP port to listen on (default 4096)
 * @returns {Promise<string>} The server URL (e.g. http://localhost:4096)
 * @throws If the binary cannot be found, the process exits early, or startup times out.
 */
export async function start(port = 4096) {
  _lastPort = port;
  if (_process && _serverUrl) {
    return _serverUrl;
  }
  if (_startPromise) {
    return _startPromise;
  }
  _startPromise = doStart(port).finally(() => {
    _startPromise = null;
  });
  return _startPromise;
}

async function doStart(port) {
  const binary = await findBinary();
  if (!binary) {
    const installHint = process.platform === 'win32'
      ? '安装方法: npm install -g opencode-ai'
      : '安装方法: curl -fsSL https://opencode.ai/install | bash';
    throw new Error(
      `找不到 opencode 二进制文件。请确认 opencode 已安装。\n${installHint}`
    );
  }

  const url = `http://localhost:${port}`;

  // If something is already serving on the port (e.g. the user started
  // `opencode serve` manually, or another daemon owns it), reuse it instead of
  // spawning a duplicate that would fail to bind. This also makes `preconnect`
  // cheap when serve is already warm.
  if (await waitForReady(url, 1500)) {
    console.error(`[opencode-serve-manager] Reusing existing server on ${url}`);
    _serverUrl = url;
    _started = true;
    return url;
  }

  console.error(`[opencode-serve-manager] Starting: ${binary} serve --port ${port}`);

  // Windows .cmd/.bat shims (and bare command names) require a shell so
  // PATHEXT can resolve the real executable. Enrich PATH with common user bin
  // dirs (pnpm global, Scoop shims, …) that an IDE-launched process often lacks.
  const spawnEnv = { ...process.env };
  enrichPathWithBinDirs(spawnEnv, commonCliBinDirs(homedir()));
  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv,
  };
  if (needsShellOnWindows(binary)) {
    spawnOpts.shell = true;
  }

  return new Promise((resolve, reject) => {
    const child = cp.spawn(binary, ['serve', '--port', String(port)], spawnOpts);
    _process = child;

    let settled = false;

    const settle = (value, isError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (isError) {
        reject(new Error(value));
      } else {
        _serverUrl = value;
        _started = true;
        // A stable run resets the auto-restart backoff so a future crash gets a
        // fresh retry budget instead of inheriting a near-exhausted counter.
        _restartAttempts = 0;
        resolve(value);
      }
    };

    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      settle('opencode serve 启动超时（15 秒）', true);
    }, 15_000);

    // Log stderr for debugging
    let stderrBuf = '';
    child.stderr?.on('data', (data) => {
      stderrBuf += data.toString('utf-8');
      const lines = stderrBuf.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        console.error(`[opencode-serve-manager:stderr] ${lines.slice(-1)[0]}`);
      }
    });

    // Process errors (e.g. spawn ENOENT, permission denied)
    child.on('error', (err) => {
      console.error(`[opencode-serve-manager] process error: ${err.message}`);
      if (err.code === 'ENOENT') {
        settle(`找不到可执行文件: ${binary}`, true);
      } else {
        settle(`无法启动 opencode: ${err.message}`, true);
      }
    });

    // Unexpected early exit
    child.on('exit', (code, signal) => {
      console.error(`[opencode-serve-manager] exited: code=${code} signal=${signal}`);
      if (!settled) {
        settle(`opencode 意外退出（退出码: ${code ?? signal}）`, true);
      } else {
        // Normal exit after a successful start (e.g. stop()) — clear state.
        if (_process === child) {
          _process = null;
          _serverUrl = null;
        }
        // Steady-state crash (started successfully, not an intentional stop):
        // schedule a backoff auto-restart so the bridge self-heals without
        // waiting for the next outgoing request.
        if (_started && !_stopRequested) {
          scheduleAutoRestart();
        } else if (_stopRequested) {
          _started = false;
        }
      }
    });

    // Start polling the health endpoint
    waitForReady(url, 15_000)
      .then((ready) => {
        if (ready) {
          _serverUrl = url;
          settle(url, false);
        } else {
          settle('opencode serve 未能就绪（超时）', true);
        }
      })
      .catch((err) => {
        settle(`健康检查失败: ${err.message}`, true);
      });
  });
}

/**
 * @returns {boolean} Whether a serve process is currently alive. Used by the
 * daemon to detect a crashed serve and re-launch it on the next request.
 */
export function isRunning() {
  return _process !== null;
}

/**
 * Backoff-restricted auto-restart after a steady-state crash.
 *
 * Guarded by `_stopRequested` (never fight an intentional stop()) and
 * `MAX_RESTART_ATTEMPTS` (avoid a restart storm when the binary is missing or
 * the port is permanently occupied). Rebinds `_lastPort` so the restart uses
 * the same port the daemon originally requested. Re-entrancy is handled by
 * `_startPromise` inside start() and the `_process` guard below.
 */
function scheduleAutoRestart() {
  if (_stopRequested || _process) return;
  if (_restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error('[opencode-serve-manager] Auto-restart limit reached; giving up on opencode serve');
    return;
  }
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** _restartAttempts, BACKOFF_MAX_MS);
  _restartAttempts += 1;
  console.error(
    `[opencode-serve-manager] Scheduling auto-restart in ${delay}ms (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
  );
  setTimeout(() => {
    if (_stopRequested || _process) return; // a newer process owns the slot now
    start(_lastPort).catch((err) => {
      console.error(`[opencode-serve-manager] auto-restart failed: ${err?.message || err}`);
    });
  }, delay);
}

/**
 * Stop the opencode serve process.
 *
 * On Unix: sends SIGTERM first; if the process hasn't exited within 5 seconds,
 * escalates to SIGKILL.
 * On Windows: SIGTERM is not supported; uses proc.kill() which calls
 * TerminateProcess. If the process hasn't exited within 5 seconds, uses
 * taskkill /F /T to force-kill the process tree.
 *
 * No-op when nothing is running.
 *
 * @returns {Promise<void>}
 */
export async function stop() {
  _stopRequested = true;
  const proc = _process;
  if (!proc) return;

  console.error('[opencode-serve-manager] Stopping opencode serve...');

  const isWin = process.platform === 'win32';

  return new Promise((resolve) => {
    const forceKill = setTimeout(() => {
      console.error(`[opencode-serve-manager] Timeout — force killing${isWin ? ' (taskkill)' : ' (SIGKILL)'}`);
      if (proc && proc.exitCode === null) {
        if (isWin) {
          // Windows: use taskkill to kill the process tree (spawned with shell: true
          // for .cmd shims, so the actual node process is a child of cmd.exe).
          try {
            cp.execSync(`taskkill /F /T /PID ${proc.pid}`, {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            // Process may have already exited
          }
        } else {
          proc.kill('SIGKILL');
        }
      }
    }, 5_000);

    proc.on('exit', () => {
      clearTimeout(forceKill);
      console.error('[opencode-serve-manager] opencode serve stopped');
      if (_process === proc) {
        _process = null;
        _serverUrl = null;
      }
      resolve();
    });

    // On Windows, SIGTERM is not a valid signal — proc.kill() without a signal
    // uses TerminateProcess which is the closest equivalent.
    if (isWin) {
      proc.kill();
    } else {
      proc.kill('SIGTERM');
    }
  });
}
