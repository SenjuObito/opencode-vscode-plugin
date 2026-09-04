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
import { resolveOpenCodeCliPath, isWindowsCmdShim } from '../../utils/cli-path.js';

/** @type {cp.ChildProcess | null} */
let _process = null;
let _serverUrl = null;
/** @type {Promise<string> | null} */
let _startPromise = null;

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
 * 失败原因分类码。宿主（OpenCodeDaemonBridge → WindowEventHandler）据此生成
 * 面向用户的提示：NOT_INSTALLED（给安装命令）/ 超时 / 通用启动失败。
 * daemon.js 的 catch 会把 `error.code` 一并回传给宿主。
 */
export const OPENCODE_NOT_FOUND = 'OPENCODE_NOT_FOUND';
export const OPENCODE_SPAWN_ENOENT = 'OPENCODE_SPAWN_ENOENT';
export const OPENCODE_SPAWN_ERROR = 'OPENCODE_SPAWN_ERROR';
export const OPENCODE_EXITED = 'OPENCODE_EXITED';
export const OPENCODE_SERVE_TIMEOUT = 'OPENCODE_SERVE_TIMEOUT';
export const OPENCODE_SERVE_NOT_READY = 'OPENCODE_SERVE_NOT_READY';

/** 创建一个带分类码的 Error（Error.code 会被 daemon.js 原样回传）。 */
function serveError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 平台对应的 opencode 安装命令（宿主的「未安装」提示会原样展示给用户）。 */
export function openCodeInstallCommand() {
  return process.platform === 'win32'
    ? 'npm install -g opencode-ai'
    : 'curl -fsSL https://opencode.ai/install | bash';
}

/**
 * 取 stderr 最后几行，便于把 opencode serve 的真实报错带给用户。
 * 控制长度，避免把整段堆栈塞进状态栏。
 */
function stderrTail(buffer, maxChars = 300) {
  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const tail = lines.slice(-3).join(' | ');
  return tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
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
  if (resolved && isExecutable(resolved)) {
    return resolved;
  }
  return null;
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
  const url = `http://localhost:${port}`;

  // If something is already serving on the port (e.g. the user started
  // `opencode serve` manually, or another daemon owns it), reuse it instead of
  // spawning a duplicate that would fail to bind. This also makes `preconnect`
  // cheap when serve is already warm.
  //
  // 必须先探端口再找二进制：端口上已有 serve 时，「opencode 未安装」是误报。
  if (await waitForReady(url, 1500)) {
    console.error(`[opencode-serve-manager] Reusing existing server on ${url}`);
    _serverUrl = url;
    return url;
  }

  const binary = await findBinary();
  if (!binary) {
    // 最常见的失败：用户根本没装 opencode。宿主持此 code 直接给出安装命令。
    console.error(
      '[opencode-serve-manager] 找不到 opencode 可执行文件。' +
      ` 已检查 env(OPENCODE_BIN/OPENCODE_PATH/OPENCODE_CLI_PATH)、PATH、~/.opencode/bin、~/.local/bin、~/.local/share/opencode/bin。` +
      ` 平台=${process.platform}，安装命令=${openCodeInstallCommand()}`,
    );
    throw serveError(
      `找不到 opencode 可执行文件，请确认已安装。安装命令：${openCodeInstallCommand()}`,
      OPENCODE_NOT_FOUND,
    );
  }

  console.error(`[opencode-serve-manager] 已解析 opencode 二进制: ${binary}`);

  console.error(`[opencode-serve-manager] Starting: ${binary} serve --port ${port}`);

  // Windows .cmd/.bat shims require shell: true to spawn correctly.
  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (isWindowsCmdShim(binary)) {
    spawnOpts.shell = true;
  }

  return new Promise((resolve, reject) => {
    const child = cp.spawn(binary, ['serve', '--port', String(port)], spawnOpts);
    _process = child;

    let settled = false;

    const killChild = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // 进程可能已经退出
        }
      }
    };

    const settle = (value, isError, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (isError) {
        // 失败时不要让半死的 serve 进程残留，否则重试会撞上端口占用/僵尸进程。
        killChild();
        if (_process === child) {
          _process = null;
        }
        _serverUrl = null;
        reject(serveError(value, code));
      } else {
        _serverUrl = value;
        resolve(value);
      }
    };

    // Log stderr for debugging（同时作为失败原因的素材，故声明在定时器之前）
    let stderrBuf = '';

    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      const detail = stderrTail(stderrBuf);
      settle(
        `opencode serve 启动超时（15 秒）${detail ? `，最后输出：${detail}` : ''}`,
        true,
        OPENCODE_SERVE_TIMEOUT,
      );
    }, 15_000);

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
        settle(
          `找不到可执行文件: ${binary}。请确认 opencode 已安装（${openCodeInstallCommand()}）`,
          true,
          OPENCODE_SPAWN_ENOENT,
        );
      } else if (err.code === 'EACCES') {
        settle(
          `没有执行权限: ${binary}。请检查文件权限（chmod +x）`,
          true,
          OPENCODE_SPAWN_ERROR,
        );
      } else {
        settle(`无法启动 opencode: ${err.message}`, true, OPENCODE_SPAWN_ERROR);
      }
    });

    // Unexpected early exit
    child.on('exit', (code, signal) => {
      console.error(`[opencode-serve-manager] exited: code=${code} signal=${signal}`);
      if (!settled) {
        const detail = stderrTail(stderrBuf);
        settle(
          `opencode 意外退出（退出码: ${code ?? signal}）${detail ? `：${detail}` : ''}`,
          true,
          OPENCODE_EXITED,
        );
      } else {
        // Normal exit after a successful start (e.g. stop()) — clear state.
        if (_process === child) {
          _process = null;
          _serverUrl = null;
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
          const detail = stderrTail(stderrBuf);
          settle(
            `opencode serve 未能就绪（15 秒内端口 ${port} 无响应）${detail ? `，最后输出：${detail}` : ''}`,
            true,
            OPENCODE_SERVE_NOT_READY,
          );
        }
      })
      .catch((err) => {
        settle(`健康检查失败: ${err.message}`, true, OPENCODE_SERVE_NOT_READY);
      });
  });
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
