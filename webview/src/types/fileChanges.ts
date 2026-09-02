/**
 * File changes types for StatusPanel
 */

/** File change status: A = Added (new file), M = Modified, D = Deleted by AI */
export type FileChangeStatus = 'A' | 'M' | 'D';

/** Single edit operation record */
export interface EditOperation {
  toolName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  replaceAll?: boolean;
  lineStart?: number;
  lineEnd?: number;
  /** Delete-file marker operation（文件被 AI 删除，无法凭文本还原） */
  kind?: 'delete-file';
  /**
   * 工具已发出（tool_use 已出现）但 tool_result 尚未到达 —— 该编辑仍在进行中。
   * 用于让 Edits 列表在流式期间实时出现（类比 todos 保持 in_progress），
   * 待 tool_result 到达后变为 false。仅 is_error 的 tool_result 会被整体丢弃。
   */
  pending?: boolean;
}

/** Aggregated file change summary */
export interface FileChangeSummary {
  filePath: string;
  fileName: string;
  status: FileChangeStatus;
  /** Total additions (sum of all operations) */
  additions: number;
  /** Total deletions (sum of all operations) */
  deletions: number;
  /** First reliable line range for file-level navigation */
  lineStart?: number;
  lineEnd?: number;
  /** All edit operations for this file (for showMultiEditDiff) */
  operations: EditOperation[];
  /** 任一编辑操作仍在进行中（tool_result 未到达）。UI 显示 pending 指示并禁用撤销/对比。 */
  pending?: boolean;
}
