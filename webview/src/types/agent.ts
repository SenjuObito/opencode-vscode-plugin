/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Unique identifier */
  id: string;
  /** Agent name (max 20 characters) */
  name: string;
  /** Prompt (max 100000 characters) */
  prompt?: string;
  /** Creation timestamp */
  createdAt?: number;
  /** opencode agent mode: 'primary' = 主代理, 'subagent' = 子代理, 'all' = 聚合 */
  mode?: 'primary' | 'subagent' | 'all' | string;
  /** 隐藏的系统代理(Compaction/Title/Summary) */
  hidden?: boolean;
  /** 简短描述 */
  description?: string;
}

/**
 * Agent operation result
 */
export interface AgentOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}
