import type { FileItem, DropdownItemData } from '../types';
import { fileReferenceProvider, fileToDropdownItem } from './fileReferenceProvider';
import {
  subagentMentionProvider,
  subagentMentionToDropdownItem,
  type SubagentMentionItem,
} from './agentProvider';
import i18n from '../../../i18n/config';

/**
 * Unified @-mention item: either a file reference (existing behavior) or a
 * subagent invocation (new). Section headers group the two lists in the dropdown.
 */
export type MentionItem =
  | ({ kind: 'file' } & FileItem)
  | ({ kind: 'subagent' } & SubagentMentionItem)
  | { kind: 'section'; label: string };

/**
 * Combined @-mention provider.
 *
 * Merges the file-reference list (backend `list_files`) with the opencode
 * subagent list (mode==='subagent' && !hidden). Subagents are grouped first
 * under a "子代理" header; files follow under a "文件" header. Each half is
 * independent: if the agents backend is unavailable the file list still works.
 */
export async function mentionProvider(
  query: string,
  signal: AbortSignal
): Promise<MentionItem[]> {
  const [files, subs] = await Promise.all([
    fileReferenceProvider(query, signal).catch(() => [] as FileItem[]),
    subagentMentionProvider(query, signal).catch(() => [] as SubagentMentionItem[]),
  ]);

  const items: MentionItem[] = [];

  if (subs.length > 0) {
    items.push({ kind: 'section', label: i18n.t('chat.subagentsSection') });
    for (const s of subs) {
      items.push({ kind: 'subagent', ...s });
    }
  }

  if (files.length > 0) {
    items.push({ kind: 'section', label: i18n.t('chat.filesSection') });
    for (const f of files) {
      items.push({ kind: 'file', ...f });
    }
  }

  return items;
}

/**
 * Convert a MentionItem to its dropdown representation.
 */
export function mentionToDropdownItem(item: MentionItem): DropdownItemData {
  if (item.kind === 'section') {
    return {
      id: `section:${item.label}`,
      label: item.label,
      type: 'section-header',
    };
  }
  if (item.kind === 'subagent') {
    return subagentMentionToDropdownItem(item);
  }
  return fileToDropdownItem(item);
}
