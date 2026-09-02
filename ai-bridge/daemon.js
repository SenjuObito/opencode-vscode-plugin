#!/usr/bin/env node

/**
 * AI Bridge Daemon Process (opencode-only)
 *
 * Long-running Node.js process that keeps a persistent `opencode serve`
 * connection (via @opencode-ai/sdk v2) alive and handles multiple requests over
 * stdin/stdout using NDJSON protocol.
 *
 * Protocol (stdin, one JSON per line):
 *   {"id":"1","method":"opencode.send","params":{...}}
 *   {"id":"2","method":"heartbeat"}
 *
 * Protocol (stdout, one JSON per line):
 *   {"type":"daemon","event":"ready","pid":12345}           // daemon lifecycle
 *   {"id":"1","line":"[STREAM_START]"}                      // command output
 *   {"id":"1","line":"[CONTENT_DELTA] \"Hello\""}           // streaming delta
 *   {"id":"1","done":true,"success":true}                   // command complete
 *   {"id":"2","type":"heartbeat","ts":1234567890}           // heartbeat response
 *
 * Key advantages over per-request spawning:
 * - opencode serve + SSE subscription reused across requests (no cold start)
 * - Process always warm
 * - Persistent session state across requests
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'readline';
import { handleOpenCodeCommand } from './channels/opencode-channel.js';
import { requestContext } from './request-context.js';
import {
  sendMessagePersistent,
  sendShellPersistent,
  preconnectPersistent,
  shutdownPersistentRuntimes,
  abortCurrentTurn,
  getContextUsagePersistent,
} from './services/opencode/opencode-daemon-service.js';
import { listModels as listOpenCodeModels } from './services/opencode/models-service.js';
import { isWebviewControlledEnvVar, isDangerousEnvVar } from './config/api-config.js';

// (Removed) Startup env sync from ~/.claude/settings.json gated by
// ~/.codemoss/config.json provider mode — all configuration is now owned by
// the VS Code settings API on the extension-host side and delivered per
// request; the bridge reads no config files from disk.

// =============================================================================
// Constants
// =============================================================================

// NOTE: Keep in sync with package.json version when updating.
const DAEMON_VERSION = '1.0.0';

// =============================================================================
// State
// =============================================================================

// The id of the in-flight opencode.send / opencode.shell turn.  SSE events
// emitted by the long-lived background subscription run outside any request
// context, so they fall back to this id (preserving the old global behavior).
let backgroundStreamRequestId = null;
let isDaemonMode = true;
let sdkPreloaded = false;

function currentRequestId() {
  return requestContext.getStore()?.id ?? backgroundStreamRequestId ?? null;
}

function isTurnCommand(method) {
  if (typeof method !== 'string') return false;
  const dotIndex = method.indexOf('.');
  const command = dotIndex >= 0 ? method.substring(dotIndex + 1) : method;
  return command === 'send' || command === 'shell';
}

// =============================================================================
// Output Interception
//
// The message-service.js / marker-protocol.js use console.log('[TAG]', data) and
// process.stdout.write('[CONTENT_DELTA] ...\n') to communicate with the host.
// In daemon mode, we intercept these to wrap each line in a JSON envelope
// tagged with the current request ID, so the host can demux responses.
// =============================================================================

const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
const _originalStderrWrite = process.stderr.write.bind(process.stderr);
const _originalConsoleLog = console.log.bind(console);
const _originalConsoleError = console.error.bind(console);

// =============================================================================
// GUI Login Environment Fix (must run before any subprocess spawns)
// =============================================================================
//
// GUI-launched IDEs (JetBrains via WSL on Windows, Dock-launched on macOS)
// don't source the user's shell init files, so the daemon inherits a minimal
// system PATH. Probe the user's login shell once at startup and apply a
// whitelist of runtime env vars so every subprocess this daemon spawns —
// the opencode binary, MCP servers, Bash tool, any future tool — automatically
// sees the user's full environment without per-tool host-side patches.

// Fix WSL-style HOME on native Windows: when the IDE/launcher injects a WSL mount
// path (e.g. HOME=/mnt/c/Users/me) but the daemon's Bash tool is Git Bash (MSYS,
// which uses /c/...), tools like git can't resolve it and fall back to a phantom
// ~/.gitconfig, breaking config/credentials. Normalize it to the native Windows home
// before any subprocess is spawned.
if (process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(process.env.HOME || '')) {
  const m = process.env.HOME.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (m) process.env.HOME = `${m[1].toUpperCase()}:/${m[2]}`;
}

if (process.platform !== 'win32' && !process.env.__AI_BRIDGE_ENV_PROBED) {
  // PATH is critical; runtime homes let tools resolve config/data dirs correctly
  const VARS_TO_INHERIT = new Set([
    'PATH',
    'NVM_DIR',
    'PYENV_ROOT',
    'RUSTUP_HOME', 'CARGO_HOME',
    'GOPATH', 'GOROOT',
    'JAVA_HOME',
    'SDKMAN_DIR', 'RBENV_ROOT',
  ]);

  const loginShell = process.env.SHELL || '/bin/bash';
  const shellBase = path.basename(loginShell);
  // fish reads config.fish by default; all other POSIX shells need -l for login profile
  const loginFlag = shellBase === 'fish' ? '-c' : '-lc';

  const tryProbeEnv = (shell, flag) => {
    try {
      return execFileSync(shell, [flag, 'env -0'], {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  let raw = tryProbeEnv(loginShell, loginFlag);
  let probeSource = raw ? loginShell : null;

  if (!raw && loginShell !== '/bin/bash') {
    raw = tryProbeEnv('/bin/bash', '-lc');
    if (raw) probeSource = '/bin/bash';
  }

  let applied = 0;
  if (raw) {
    for (const entry of raw.split('\0')) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx < 1) continue;
      const key = entry.slice(0, eqIdx);
      if (!VARS_TO_INHERIT.has(key)) continue;
      const val = entry.slice(eqIdx + 1);
      if (key === 'PATH') {
        // Merge rather than replace: the host launcher already enriched PATH (Homebrew,
        // nvm, ...), so adopting a login-shell PATH wholesale would drop those entries
        // whenever the shell returns a minimal one. Union (current first, append only
        // unseen entries) keeps every launcher path while still picking up dirs the
        // launcher missed (pyenv/rustup/sdkman). This also fixes Apple-Silicon Homebrew
        // PATHs, which the old "$HOME must appear" guard wrongly rejected.
        const current = process.env.PATH || '';
        const seen = new Set(current.split(path.delimiter).filter(Boolean));
        const additions = val.split(path.delimiter).filter((p) => p && !seen.has(p));
        if (additions.length > 0) {
          process.env.PATH = current
            ? `${current}${path.delimiter}${additions.join(path.delimiter)}`
            : val;
          applied++;
        }
        continue;
      }
      if (val !== process.env[key]) {
        process.env[key] = val;
        applied++;
      }
    }
  }

  process.env.__AI_BRIDGE_ENV_PROBED = '1';
  _originalStderrWrite(
    `[daemon] env probe: shell=${probeSource ?? 'none'} vars-applied=${applied}\n`,
    'utf8',
  );
}

/**
 * Write a raw NDJSON line to stdout (bypasses interception).
 */
function writeRawLine(obj) {
  _originalStdoutWrite(JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Send a daemon lifecycle event.
 */
function sendDaemonEvent(event, data = {}) {
  writeRawLine({ type: 'daemon', event, ...data });
}

/**
 * Override process.stdout.write to tag output with request ID.
 */
process.stdout.write = function (chunk, encoding, callback) {
  // Convert Buffer to string if needed
  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');

  const requestId = currentRequestId();
  if (requestId) {
    // Tag output with request ID for demuxing on host side
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        writeRawLine({ id: requestId, line });
      }
    }
    if (typeof callback === 'function') callback();
    return true;
  }

  // No active request — check if this is already JSON (daemon event).
  // SAFETY: writeRawLine() always produces lines starting with '{' (JSON.stringify
  // of an object), so they pass through to _originalStdoutWrite without recursion.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return _originalStdoutWrite(chunk, encoding, callback);
  }

  // Non-JSON output without a request context (e.g., SDK debug logs during preload)
  // Wrap as a daemon log event so the host's NDJSON parser can handle it
  if (trimmed.length > 0) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim().length > 0) {
        writeRawLine({ type: 'daemon', event: 'log', message: line });
      }
    }
  }
  if (typeof callback === 'function') callback();
  return true;
};

// Expose the pre-interception writer so out-of-band emitters can write
// process-level NDJSON that must NOT be wrapped with activeRequestId.
process.stdout._originalStdoutWrite = _originalStdoutWrite;
// Expose the pre-interception stderr writer so out-of-band code can log without
// being tagged with the active request's id and corrupting its stdout stream.
process.stderr._originalStderrWrite = _originalStderrWrite;

/**
 * Override console.log to go through our tagged stdout.
 */
console.log = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(text + '\n');
};

/**
 * Override console.error to tag stderr output as well.
 */
console.error = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const requestId = currentRequestId();
  if (requestId) {
    writeRawLine({ id: requestId, stderr: text });
  } else {
    _originalStderrWrite(text + '\n', 'utf8');
  }
};

// =============================================================================
// Prevent process.exit() from killing the daemon
// =============================================================================

const _originalExit = process.exit;
process.exit = function (code) {
  if (isDaemonMode) {
    // Capture the current request ID before clearing it, so the catch block
    // in processRequest() won't try to send a duplicate done signal.
    const capturedId = currentRequestId();
    backgroundStreamRequestId = null;

    if (capturedId) {
      if (code === 0) {
        writeRawLine({ id: capturedId, done: true, success: true });
      } else {
        writeRawLine({
          id: capturedId,
          done: true,
          success: false,
          error: `process.exit(${code}) intercepted by daemon`,
        });
      }
    }
    // Throw to unwind the current call stack instead of actually exiting.
    // processRequest's catch block checks activeRequestId === null and
    // will skip sending a duplicate done signal.
    throw new Error(`[daemon] process.exit(${code}) intercepted`);
  }
  _originalExit(code);
};

// Best-effort guard for process.exitCode writes.
// Node.js v24+ may expose `process.exitCode` as non-configurable.
// In that case redefining it throws and would crash daemon startup.
try {
  const exitCodeDescriptor = Object.getOwnPropertyDescriptor(process, 'exitCode');
  if (exitCodeDescriptor?.configurable) {
    let _exitCode = process.exitCode || 0;
    Object.defineProperty(process, 'exitCode', {
      set(code) {
        if (!isDaemonMode) {
          _exitCode = code;
        }
      },
      get() {
        return _exitCode;
      },
      configurable: true,
    });
  }
} catch (error) {
  _originalStderrWrite(`[daemon] Unable to patch process.exitCode: ${error.message}\n`, 'utf8');
}

// =============================================================================
// SDK Pre-loading
// =============================================================================

async function preloadSdks() {
  try {
    sendDaemonEvent('sdk_loading', { provider: 'opencode' });
    // Verify the @opencode-ai/sdk v2 entrypoint resolves. No serve connection is
    // made here — the serve process + SSE subscription are lazily started by the
    // first preconnect/send. The import itself is the expensive one-time load.
    const mod = await import('@opencode-ai/sdk/v2');
    if (mod && typeof mod.createOpencodeClient === 'function') {
      sdkPreloaded = true;
      sendDaemonEvent('sdk_loaded', { provider: 'opencode' });
    } else {
      sdkPreloaded = false;
      sendDaemonEvent('sdk_unavailable', { provider: 'opencode' });
    }
  } catch (e) {
    sdkPreloaded = false;
    sendDaemonEvent('sdk_load_error', {
      provider: 'opencode',
      error: e?.message || String(e),
    });
  }
}

// =============================================================================
// Request Processing
// =============================================================================

/**
 * Process a single request from stdin.
 */
async function processRequest(request) {
  const { id, method, params = {} } = request;

  // --- Heartbeat (no request ID needed) ---
  if (method === 'heartbeat') {
    writeRawLine({
      id: id || '0',
      type: 'heartbeat',
      ts: Date.now(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage().heapUsed,
    });
    return;
  }

  // --- Status query ---
  if (method === 'status') {
    writeRawLine({
      id,
      type: 'status',
      version: DAEMON_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage(),
    });
    return;
  }

  // --- Graceful shutdown ---
  if (method === 'shutdown') {
    await shutdownPersistentRuntimes();
    sendDaemonEvent('shutdown', { reason: 'requested' });
    writeRawLine({ id: id || '0', done: true, success: true });
    isDaemonMode = false;
    // Allow a brief delay for the response to flush before exiting
    setTimeout(() => _originalExit(0), 100);
    return;
  }

  // --- Command execution ---
  if (!id) {
    _originalStderrWrite(
      `[daemon] Ignoring request without id: ${method}\n`,
      'utf8'
    );
    return;
  }

  // Turn commands (send / shell) own the SSE stream; mark them as the
  // background stream owner so events emitted outside any request context
  // (the long-lived SSE subscription) are still attributed to the active turn.
  const turnCommand = isTurnCommand(method);
  if (turnCommand) {
    backgroundStreamRequestId = id;
  }

  // Save original env values for restoration after request completes.
  // Env vars are only applied to turn commands: shared read-only commands run
  // concurrently and must not race on process.env mutations.
  const savedEnv = {};

  try {
    // Apply environment variables from params (with save for restore).
    // Only turn commands read request env; shared read-only commands run
    // concurrently and must not race on process.env mutations.
    if (turnCommand && params.env && typeof params.env === 'object') {
      for (const [key, value] of Object.entries(params.env)) {
        // Request env can include settings.json values. Do not let stale
        // environment controls override the webview's per-turn model, context,
        // or reasoning selections.
        if (isWebviewControlledEnvVar(key)) {
          continue;
        }
        // Security (C): never let request/settings.json env inject code-execution or
        // library-injection variables (NODE_OPTIONS, LD_PRELOAD, DYLD_*, …). A malicious
        // project's settings.json env block would otherwise run arbitrary code in
        // the daemon or any child process it spawns.
        if (isDangerousEnvVar(key)) {
          console.warn(`[SECURITY] Ignoring dangerous env var from request: ${key}`);
          continue;
        }
        if (value !== undefined && value !== null) {
          // Save original value (undefined means key didn't exist)
          savedEnv[key] = process.env[key];
          process.env[key] = String(value);
        }
      }
    }

    // Parse method: "opencode.send" -> provider="opencode", command="send"
    const dotIndex = method.indexOf('.');
    if (dotIndex < 0) {
      throw new Error(`Invalid method format: ${method}. Expected "provider.command"`);
    }
    const provider = method.substring(0, dotIndex);
    const command = method.substring(dotIndex + 1);

    // Build stdinData from params (mimics what channel-manager.js does)
    const stdinData = { ...params };
    delete stdinData.env; // env is handled separately

    switch (`${provider}.${command}`) {
      case 'opencode.send':
        await sendMessagePersistent(stdinData);
        break;
      case 'opencode.shell':
        await sendShellPersistent(stdinData);
        break;
      case 'opencode.preconnect':
        await preconnectPersistent(stdinData);
        break;
      case 'opencode.getContextUsage':
        await getContextUsagePersistent(stdinData);
        break;
      case 'opencode.listModels':
      case 'opencode.getModels':
        await listOpenCodeModels();
        break;
      default:
        if (provider === 'opencode') {
          // Dispatch to the channel handler for other opencode commands.
          await handleOpenCodeCommand(command, [], stdinData);
        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }
    }

    writeRawLine({ id, done: true, success: true });
  } catch (error) {
    // Only send done if not already sent (e.g., by process.exit interceptor)
    if (backgroundStreamRequestId === id || currentRequestId() === id) {
      writeRawLine({
        id,
        done: true,
        success: false,
        error: error.message || String(error),
        code: error.code,
      });
    }
  } finally {
    if (backgroundStreamRequestId === id) {
      backgroundStreamRequestId = null;
    }
    // Restore original environment variables to prevent cross-request pollution
    for (const [key, originalValue] of Object.entries(savedEnv)) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function runDaemonMain() {
  // --- Error Handlers ---
  process.on('uncaughtException', (error) => {
    _originalStderrWrite(
      `[daemon] Uncaught exception: ${error.message}\n${error.stack}\n`,
      'utf8'
    );
    const requestId = currentRequestId();
    if (requestId) {
      writeRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Uncaught exception: ${error.message}`,
      });
      backgroundStreamRequestId = null;
    }
  });

  process.on('unhandledRejection', (reason) => {
    _originalStderrWrite(
      `[daemon] Unhandled rejection: ${reason}\n`,
      'utf8'
    );
    const requestId = currentRequestId();
    if (requestId) {
      writeRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Unhandled rejection: ${String(reason)}`,
      });
      backgroundStreamRequestId = null;
    }
  });

  // --- Startup ---
  sendDaemonEvent('starting', {
    pid: process.pid,
    version: DAEMON_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
  });

  // Pre-load SDK
  await preloadSdks();

  // Signal ready
  sendDaemonEvent('ready', {
    pid: process.pid,
    sdkPreloaded,
  });

  // --- Listen for requests on stdin ---
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Turn commands (opencode.send / opencode.shell) are serialized because they
  // own the SSE stream and the backgroundStreamRequestId fallback.  All other
  // read-only / mutation commands run concurrently inside their own ALS context
  // so that `getModels` / `listMessages` / `load_session` do not queue behind a
  // cold `opencode.preconnect`.
  let turnQueue = Promise.resolve();

  rl.on('line', (line) => {
    // Skip empty lines
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      _originalStderrWrite(
        `[daemon] Invalid JSON input: ${line.substring(0, 200)}\n`,
        'utf8'
      );
      return;
    }

    // Heartbeats and status queries don't use activeRequestId — safe to run immediately
    if (request.method === 'heartbeat' || request.method === 'status') {
      processRequest(request);
      return;
    }

    // Abort bypasses the turn queue — must run immediately to cancel active work.
    if (request.method === 'abort') {
      const targetId = backgroundStreamRequestId;
      _originalStderrWrite(
        `[daemon] Abort requested, active turn: ${targetId || 'none'}\n`,
        'utf8'
      );
      if (targetId) {
        abortCurrentTurn().catch((e) => _originalStderrWrite(`[daemon] opencode abort error: ${e.message}\n`, 'utf8'));
      }
      writeRawLine({ id: request.id || '0', done: true, success: true });
      return;
    }

    // Permission/question replies bypass the turn queue too. While such a
    // prompt is pending the session stays busy (`session.idle` won't fire), so
    // the in-flight `opencode.send` keeps the queue blocked — a queued reply
    // would deadlock the turn. We run the channel handler inside the request's
    // own ALS context so its output is still tagged with the correct id.
    if (
      request.method === 'opencode.replyQuestion'
      || request.method === 'opencode.rejectQuestion'
      || request.method === 'opencode.replyPermission'
    ) {
      const command = request.method.substring('opencode.'.length);
      const stdinData = { ...request.params };
      delete stdinData.env;
      console.log(`[daemon][bypass] ${request.method} id=${request.id} params=${JSON.stringify(stdinData)}`);
      requestContext.run({ id: request.id }, () => {
        handleOpenCodeCommand(command, [], stdinData)
          .then(() => {
            console.log(`[daemon][bypass] ${request.method} id=${request.id} SUCCESS`);
            writeRawLine({ id: request.id || '0', done: true, success: true });
          })
          .catch((e) => {
            console.error(`[daemon][bypass] ${request.method} id=${request.id} ERROR: ${e.message}`);
            _originalStderrWrite(`[daemon] ${request.method} error: ${e.message}\n`, 'utf8');
            writeRawLine({ id: request.id || '0', done: true, success: false, error: e.message });
          });
      });
      return;
    }

    // Turn commands are serialized; everything else runs concurrently.
    if (isTurnCommand(request.method)) {
      turnQueue = turnQueue
        .then(() => requestContext.run({ id: request.id }, () => processRequest(request)))
        .catch((e) => {
          _originalStderrWrite(
            `[daemon] Turn queue error: ${e.message}\n`,
            'utf8'
          );
        });
      return;
    }

    requestContext.run({ id: request.id }, () => processRequest(request)).catch((e) => {
      _originalStderrWrite(
        `[daemon] Shared request error: ${e.message}\n`,
        'utf8'
      );
    });
  });

  rl.on('close', async () => {
    // stdin closed — host process disconnected, exit gracefully
    // Force-exit after 5s to prevent zombie processes when SDK network connections hang
    const forceExitTimer = setTimeout(() => {
      _originalStderrWrite('[daemon] Shutdown timeout (5s), forcing exit\n', 'utf8');
      _originalExit(0);
    }, 5000);
    // unref() so this timer doesn't prevent natural exit if cleanup finishes fast
    forceExitTimer.unref();

    try {
      await shutdownPersistentRuntimes();
    } catch (e) {
      _originalStderrWrite(`[daemon] Failed to shutdown persistent runtimes: ${e.message}\n`, 'utf8');
    }
    clearTimeout(forceExitTimer);
    sendDaemonEvent('shutdown', { reason: 'stdin_closed' });
    isDaemonMode = false;
    _originalExit(0);
  });

  // --- Parent process monitoring ---
  // Periodically verify the host parent is still alive. When it crashes or is
  // force-killed, stdin may not close cleanly, leaving orphan daemon processes.
  // On Unix, process.ppid changes to 1 (init/launchd) when the parent dies.
  const PPID_CHECK_INTERVAL_MS = 3000;
  const initialPpid = process.ppid;
  const ppidMonitor = setInterval(() => {
    const currentPpid = process.ppid;
    // Parent changed to init (1) — reparented after death
    const reparented = currentPpid !== initialPpid && currentPpid === 1;
    // Parent PID is gone — kill(pid, 0) throws ESRCH if process doesn't exist.
    // EPERM means the process exists but we lack permission (PID was recycled by
    // a privileged process) — treat that as "still alive" to avoid false positives.
    let parentGone = false;
    if (!reparented && currentPpid !== 1) {
      try {
        process.kill(currentPpid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          parentGone = true;
        }
      }
    }
    if (reparented || parentGone) {
      _originalStderrWrite(
        `[daemon] Parent process (ppid=${initialPpid}) is gone (current ppid=${currentPpid}), exiting\n`,
        'utf8'
      );
      // Parent is dead — skip graceful cleanup to exit immediately.
      // sendDaemonEvent/shutdownPersistentRuntimes are intentionally omitted:
      // the host side cannot receive events, and the OS will reclaim sockets on exit.
      isDaemonMode = false;
      _originalExit(0);
    }
  }, PPID_CHECK_INTERVAL_MS);
  ppidMonitor.unref();

  // --- Keep alive ---
  // The process stays alive as long as stdin is open (rl keeps the event loop active)
}

runDaemonMain().catch((error) => {
  const message = error?.message || String(error);
  const stack = error?.stack || '';
  _originalStderrWrite(`[daemon] Fatal startup error: ${stack || message}\n`, 'utf8');
  try {
    sendDaemonEvent('startup_failed', { error: message, stack });
  } catch {
    // ignore — process is already broken
  }
  isDaemonMode = false;
  setTimeout(() => _originalExit(1), 150);
});
