/**
 * MCP Provider Selection
 * Unified for opencode - no longer supports Claude/Codex dual mode
 */

export function resolveInitialMcpProvider(): string {
  return 'opencode';
}

export function getMcpMessagePrefix(): '' {
  return '';
}
