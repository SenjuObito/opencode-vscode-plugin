/**
 * logger.js
 *
 * Structured logger for ai-bridge modules.
 * Ensures consistent tagging and forwarding to the host's PluginFileLogger.
 */

function formatMessage(tag, message, error) {
  const errSuffix = error
    ? (error instanceof Error
        ? ` (${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''})`
        : ` (${String(error)})`)
    : '';
  return `[${tag}] ${message}${errSuffix}`;
}

export function logInfo(tag, message) {
  console.error(`[LOG:INFO] ${formatMessage(tag, message)}`);
}

export function logWarn(tag, message) {
  console.error(`[LOG:WARN] ${formatMessage(tag, message)}`);
}

export function logError(tag, message, error) {
  console.error(`[LOG:ERROR] ${formatMessage(tag, message, error)}`);
}

export function logDebug(tag, message) {
  if (process.env.AI_BRIDGE_LOG_LEVEL !== 'error') {
    console.error(`[LOG:DEBUG] ${formatMessage(tag, message)}`);
  }
}
