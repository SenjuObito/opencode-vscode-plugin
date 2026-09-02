#!/usr/bin/env node

/**
 * AI Bridge Channel Manager (opencode-only)
 * Unified bridge entry point for the opencode provider.
 *
 * Command format:
 *   node channel-manager.js opencode <command> [args...]
 *
 * Provider:
 *   opencode - OpenCode (persistent `opencode serve` + @opencode-ai/sdk)
 *
 * Commands:
 *   send       - Send a message (parameters passed via stdin as JSON, or positionally)
 *   listModels - List models available to the local opencode server
 *
 * Messages and other parameters are passed via stdin in JSON format:
 *   { "message": "...", "sessionId": "...", "cwd": "...", "model": "...", "attachments": [...] }
 */

import { handleOpenCodeCommand } from './channels/opencode-channel.js';
import { shutdownPersistentRuntimes } from './services/opencode/opencode-daemon-service.js';

/**
 * Write a JSON payload to stdout and exit once the bytes are flushed.
 *
 * `console.log` followed by `process.exit` races the stdout buffer: for a
 * piped stdout the underlying `process.stdout.write` is asynchronous, and
 * `process.exit` does not wait for it to drain, truncating the JSON. Writing
 * explicitly and exiting in the flush callback guarantees the payload reaches
 * the OS pipe first. The timeout fallback ensures the process still terminates
 * if the callback never fires (e.g. a broken pipe).
 */
function writeJsonAndExit(payload, code = 0) {
  let exited = false;
  const exitNow = () => {
    if (!exited) {
      exited = true;
      process.exit(code);
    }
  };
  process.stdout.write(JSON.stringify(payload) + '\n', 'utf8', exitNow);
  setTimeout(exitNow, 5000);
}

/**
 * Read all of stdin as a single JSON object (if any). Resolves `{}` when stdin
 * is empty (e.g. invoked from a TTY with arguments only). A hard timeout guards
 * against a stuck stdin that never emits `end`.
 *
 * @returns {Promise<object>}
 */
function readStdinData() {
  return new Promise((resolve) => {
    let raw = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const trimmed = raw.trim();
      if (!trimmed) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve({});
      }
    };

    const timer = setTimeout(finish, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// (Removed) Startup env sync from ~/.claude/settings.json — configuration is
// owned by the VS Code settings API on the extension-host side.

// Parse command-line arguments
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

// Error handling
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_ERROR]', error.message);
  writeJsonAndExit({
    success: false,
    error: error.message
  }, 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  writeJsonAndExit({
    success: false,
    error: String(reason)
  }, 1);
});

const providerHandlers = {
  opencode: handleOpenCodeCommand,
};

// Execute command
(async () => {
  try {
    if (!provider || !providerHandlers[provider]) {
      writeJsonAndExit({
        success: false,
        error: 'Invalid provider. Use "opencode".'
      }, 1);
      return;
    }

    if (!command) {
      writeJsonAndExit({
        success: false,
        error: 'No command specified'
      }, 1);
      return;
    }

    // Read stdin data (empty when no JSON piped)
    const stdinData = await readStdinData();

    // Dispatch to the provider handler
    const handler = providerHandlers[provider];
    await handler(command, args, stdinData);

    // Tear down the persistent opencode runtime (serve process + SSE
    // subscriptions). Without this the serve child and open SSE stream keep the
    // event loop alive and a one-shot CLI process would never exit naturally.
    await shutdownPersistentRuntimes();

    // IMPORTANT: Do not use process.exit(0) here -- it terminates the process
    // before the stdout buffer is fully flushed, which can truncate large JSON
    // output. Instead, set process.exitCode and let the process exit naturally.
    process.exitCode = 0;
  } catch (error) {
    writeJsonAndExit({
      success: false,
      error: error.message
    }, 1);
  }
})();
