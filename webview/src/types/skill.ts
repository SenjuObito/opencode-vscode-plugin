/**
 * Skills type definitions
 *
 * Skills are custom command and feature extensions stored in specific directories:
 * - Global: ~/.claude/skills (enabled) / ~/.codemoss/skills/global (disabled)
 * - Local: {workspace}/.claude/skills (enabled) / ~/.codemoss/skills/{project-hash} (disabled)
 *
 * Each skill can be a file (.md) or a directory (containing skill.md)
 */

/**
 * Skill type: file or directory
 */
export type SkillType = 'file' | 'directory';

/**
 * Skill scope:
 * - Claude: global (user-level) or local (project-level)
 * - Codex: user (~/.agents/skills/) or repo ({cwd}/.agents/skills/)
 */
export type SkillScope = 'global' | 'local' | 'user' | 'repo';

/**
 * Skill configuration
 */
export interface Skill {
  /** Unique identifier (format: {scope}-{skillId} or {scope}-{skillId}-disabled) */
  id: string;
  /**
   * 磁盘标识：目录名（或根级 .md 去掉扩展名）。
   * 删除 / 启停都用它——`name` 是 frontmatter 的显示名，可能和目录名不同。
   */
  skillId: string;
  /** Display name (frontmatter `name`, falls back to skillId) */
  name: string;
  /** Type: file or directory */
  type: SkillType;
  /** Scope: global or local */
  scope: SkillScope;
  /** Full path */
  path: string;
  /** Whether enabled (true: in active directory, false: in managed directory) */
  enabled: boolean;
  /** 该 skill 由哪个根目录扫到（只读信息） */
  sourceDir?: string;
  /** Description (extracted from skill.md frontmatter) */
  description?: string;
  /** Skill path for Codex config.toml operations */
  skillPath?: string;
  /** frontmatter 解析异常标记（如 invalid_frontmatter） */
  warning?: string;
  /** Creation time */
  createdAt?: string;
  /** Modification time */
  modifiedAt?: string;
}

/**
 * Skills map (id -> Skill)
 */
export type SkillsMap = Record<string, Skill>;

/**
 * Skills configuration structure
 * Claude uses global/local, Codex uses user/repo
 */
export interface SkillsConfig {
  /** Global skills (Claude only) */
  global: SkillsMap;
  /** Local skills (Claude only) */
  local: SkillsMap;
  /** User-level skills (Codex only) */
  user?: SkillsMap;
  /** Repository-level skills (Codex only) */
  repo?: SkillsMap;
}

/**
 * Skills filter
 */
export type SkillFilter = 'all' | 'global' | 'local' | 'user' | 'repo';

/**
 * Skills enabled status filter
 */
export type SkillEnabledFilter = 'all' | 'enabled' | 'disabled';
