/**
 * MCP (Model Context Protocol) type definitions
 *
 * MCP is Anthropic's standard protocol for AI models to communicate with external tools and data sources.
 *
 * Configuration is stored in opencode.json under the "mcp" field.
 */

/**
 * MCP server connection specification
 * Supports two connection types: local (stdio), remote (Streamable HTTP)
 */
export interface McpServerSpec {
  /** Connection type: 'local' for stdio, 'remote' for HTTP */
  type?: 'local' | 'remote' | 'stdio' | 'http' | 'sse';

  // Local type fields (stdio)
  /** Command to execute (required for local type) */
  command?: string | string[];
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Environment variables (opencode format) */
  environment?: Record<string, string>;
  /** Working directory */
  cwd?: string;

  // Remote type fields (Streamable HTTP)
  /** Server URL (required for remote type) */
  url?: string;
  /** Request headers */
  headers?: Record<string, string>;

  /** Whether enabled */
  enabled?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;

  /** Allow extension fields */
  [key: string]: any;
}

/**
 * MCP server full configuration
 */
export interface McpServer {
  /** Unique identifier (key in config file) */
  id: string;
  /** Display name */
  name?: string;
  /** Server connection specification */
  server: McpServerSpec;
  /** Description */
  description?: string;
  /** Tags */
  tags?: string[];
  /** Homepage link */
  homepage?: string;
  /** Documentation link */
  docs?: string;
  /** Whether enabled */
  enabled?: boolean;
  /** Allow extension fields */
  [key: string]: any;
}

/**
 * MCP server map (id -> McpServer)
 */
export type McpServersMap = Record<string, McpServer>;

/**
 * OpenCode config file structure (opencode.json)
 */
export interface OpenCodeConfig {
  /** MCP configuration */
  mcp?: Record<string, McpServerSpec>;
  /** Other configuration */
  [key: string]: any;
}

/**
 * MCP preset configuration
 */
export interface McpPreset {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  server: McpServerSpec;
  homepage?: string;
  docs?: string;
}

/**
 * MCP server status
 */
export type McpServerStatus = 'connected' | 'checking' | 'error' | 'unknown';

/**
 * MCP server connection status info (from OpenCode SDK)
 */
export interface McpServerStatusInfo {
  /** Server name */
  name: string;
  /** Connection status */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Server info (available on successful connection) */
  serverInfo?: {
    name: string;
    version: string;
  };
  /** Error message (available on connection failure) */
  error?: string;
}

/**
 * MCP connection log entry
 */
export interface McpLogEntry {
  /** Unique identifier */
  id: string;
  /** Timestamp */
  timestamp: Date;
  /** Server name */
  serverName: string;
  /** Log level */
  level: 'info' | 'warn' | 'error' | 'success';
  /** Log message */
  message: string;
}

/**
 * MCP server validation result
 */
export interface McpServerValidationResult {
  valid: boolean;
  serverId?: string;
  errors?: string[];
  warnings?: string[];
}

// ==================== MCP Marketplace Types ====================

/**
 * MCP marketplace source returned by the backend.
 */
export interface McpMarketplaceSource {
  id: string;
  name: string;
  type: 'BUILT_IN' | 'REGISTRY' | 'GITHUB_ORG';
  url: string;
  enabled: boolean;
}

/**
 * Install option for a marketplace entry.
 */
export interface McpInstallOption {
  label: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  source?: string;
  riskLevel?: string;
}

/**
 * Normalized MCP marketplace entry.
 */
export interface McpMarketplaceEntry {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  status?: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  homepage?: string;
  repositoryUrl?: string;
  docsUrl?: string;
  official: boolean;
  tags: string[];
  installOptions: McpInstallOption[];
}

/**
 * MCP marketplace search response.
 */
export interface McpMarketplaceSearchResponse {
  query: string;
  sourceId: string;
  entries: McpMarketplaceEntry[];
  error?: string;
}

/**
 * Response for an external MCP configuration import (e.g. GitHub Copilot format).
 * The servers are already mapped to internal entries by the Java backend.
 */
export interface McpImportPreviewResponse {
  servers: McpServer[];
  error?: string;
}
