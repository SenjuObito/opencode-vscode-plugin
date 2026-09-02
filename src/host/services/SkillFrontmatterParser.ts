/**
 * SkillFrontmatterParser — parse YAML frontmatter from SKILL.md files.
 * Lightweight regex-based parser (no YAML library dependency).
 */
import { promises as fsp } from 'fs';
import { join } from 'path';

export interface SkillMetadata {
	name: string;
	description: string;
}

/**
 * Parse SKILL.md frontmatter from a skill directory or file path.
 * Looks for SKILL.md first, then skill.md.
 */
export async function parseSkillMetadata(skillPath: string): Promise<SkillMetadata | null> {
	let stat;
	try {
		stat = await fsp.stat(skillPath);
	} catch {
		return null;
	}

	let mdPath: string;
	if (stat.isDirectory()) {
		// Try SKILL.md first, then skill.md
		const candidates = ['SKILL.md', 'skill.md'];
		for (const name of candidates) {
			const p = join(skillPath, name);
			try {
				await fsp.access(p);
				mdPath = p;
				break;
			} catch {
				// continue
			}
		}
		if (!mdPath!) {
			return null;
		}
	} else {
		mdPath = skillPath;
	}

	let content: string;
	try {
		content = await fsp.readFile(mdPath, 'utf-8');
	} catch {
		return null;
	}

	return parseFrontmatter(content);
}

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts between first `---` and second `---`.
 */
export function parseFrontmatter(content: string): SkillMetadata | null {
	// Match frontmatter block: ---\n...\n---
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
	if (!match) {
		return null;
	}

	const yamlBlock = match[1];
	let name = '';
	let description = '';

	// Extract name: value
	const nameMatch = yamlBlock.match(/^name:\s*(.+)$/m);
	if (nameMatch) {
		name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
	}

	// Extract description: value (may be multi-line quoted string)
	const descMatch = yamlBlock.match(/^description:\s*(.+)$/m);
	if (descMatch) {
		description = descMatch[1].trim().replace(/^["']|["']$/g, '');
	}

	if (!name) {
		return null;
	}

	// Fallback: first paragraph after frontmatter as description
	if (!description) {
		const bodyAfterFrontmatter = content.slice(match[0].length);
		const firstParagraph = bodyAfterFrontmatter.match(/\n\s*\n\s*(.+?)(?:\n\s*\n|\n#|\n*$)/s);
		if (firstParagraph) {
			description = firstParagraph[1].trim();
		}
	}

	return { name, description };
}
