/**
 * API configuration module.
 *
 * opencode-only build: all persistent configuration is owned by the VS Code
 * extension host via the VS Code settings API and passed to the bridge per
 * request — the bridge no longer reads any ~/.codemoss/config.json or
 * ~/.claude/settings.json state from disk. This module retains only the
 * webview-owned env-var guards and the dangerous-env-var security filter used
 * by the daemon's request handling.
 */

// Conditional debug logging: set CLAUDE_DEBUG=1 to enable verbose diagnostics
const DEBUG = process.env.CLAUDE_DEBUG === '1' || process.env.CLAUDE_DEBUG === 'true';
export function debugLog(...args) {
  if (DEBUG) {
    console.error(...args);
  }
}

// ============================================================================
// Webview-owned env vars
// ============================================================================

// Env vars whose value the webview owns per request. Settings.json copies of
// these must never be applied on top of the current request's selections.
//
// Model routing: chosen by the webview model selector and written to
// process.env by setModelEnvironmentVariables() each turn.
const MODEL_ROUTING_ENV_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

// Reasoning / context controls: explicit SDK options in this bridge. Claude Code
// gives env vars higher priority than SDK args, so stale settings values must be
// neutralized — stripped from the child env and overridden inline.
const REASONING_CONTROL_ENV_VARS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
];

export const WEBVIEW_CONTROLLED_ENV_VARS = Object.freeze([
  ...MODEL_ROUTING_ENV_VARS,
  ...REASONING_CONTROL_ENV_VARS,
]);

const WEBVIEW_CONTROLLED_ENV_VAR_SET = new Set(
  WEBVIEW_CONTROLLED_ENV_VARS.map((varName) => varName.toUpperCase())
);

export function isWebviewControlledEnvVar(varName) {
  return WEBVIEW_CONTROLLED_ENV_VAR_SET.has(String(varName ?? '').toUpperCase());
}

// ============================================================================
// Dangerous env vars (security filter)
// ============================================================================

// Security (C): environment variables that can hijack process startup or load arbitrary
// native/JS code. These must NEVER be accepted from request params / settings.json env,
// otherwise a malicious project's settings.json {env:{NODE_OPTIONS:'--require ...'}}
// would achieve code execution in the daemon or any child process it spawns.
// NOTE: PATH is intentionally NOT listed — the daemon's legitimate PATH is supplied by the
// launcher, and blanket-rejecting PATH would risk breaking it.
const DANGEROUS_ENV_VAR_SET = new Set([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
  'PERL5LIB',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
]);

export function isDangerousEnvVar(varName) {
  return DANGEROUS_ENV_VAR_SET.has(String(varName ?? '').toUpperCase());
}

// ============================================================================
// Startup Environment Variables
// ============================================================================

// (Removed) The old startup env injection pulled proxy/TLS/AWS settings from
// ~/.claude/settings.json, gated by the provider mode stored in
// ~/.codemoss/config.json. All configuration is now persisted through the VS
// Code settings API on the extension-host side and delivered per request, so
// the bridge never reads either file.
