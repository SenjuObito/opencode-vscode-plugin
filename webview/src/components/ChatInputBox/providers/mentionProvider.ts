import type { FileItem, DropdownItemData } from '../types';
import { fileReferenceProvider, fileToDropdownItem } from './fileReferenceProvider';
import {
  subagentMentionProvider,
  subagentMentionToDropdownItem,
  type SubagentMentionItem,
} from './agentProvider';
import i18n from '../../../i18n/config';
import { debugWarn } from '../../../utils/debug.js';

/**
 * Unified @-mention item: either a file reference (existing behavior) or a
 * subagent invocation (new). Section headers group the two lists in the dropdown.
 * `info` is a non-selectable notice (e.g. the file channel returned nothing).
 */
export type MentionItem =
  | ({ kind: 'file' } & FileItem)
  | ({ kind: 'subagent' } & SubagentMentionItem)
  | { kind: 'section'; label: string }
  | { kind: 'info'; label: string };

/**
 * Combined @-mention provider.
 *
 * Merges the file-reference list (backend `files.list`, answered by opencode
 * `fs.list` / `fs.find`) with the opencode subagent list (mode==='subagent' &&
 * !hidden). Subagents are grouped first under a "子代理" header; files follow
 * under a "文件" header. Each half is independent: if the agents backend is
 * unavailable the file list still works.
 *
 * When the file channel legitimately has nothing to show (empty query, empty
 * directory, or a failed request) we still render the "文件" header plus a
 * non-selectable notice — a section that silently disappears reads as a bug.
 */
export async function mentionProvider(
  query: string,
  signal: AbortSignal
): Promise<MentionItem[]> {
  const [files, subs] = await Promise.all([
    fileReferenceProvider(query, signal).catch((err: unknown) => {
      // Abort is a normal keystroke race; anything else is worth a log line.
      if ((err as { name?: string })?.name !== 'AbortError') {
        debugWarn('[mentionProvider] file list request failed', err);
      }
      return [] as FileItem[];
    }),
    subagentMentionProvider(query, signal).catch(() => [] as SubagentMentionItem[]),
  ]);

  const items: MentionItem[] = [];

  if (subs.length > 0) {
    items.push({ kind: 'section', label: i18n.t('chat.subagentsSection') });
    for (const s of subs) {
      items.push({ kind: 'subagent', ...s });
    }
  }

  items.push({ kind: 'section', label: i18n.t('chat.filesSection') });
  if (files.length > 0) {
    for (const f of files) {
      items.push({ kind: 'file', ...f });
    }
  } else {
    items.push({ kind: 'info', label: i18n.t('chat.filesEmpty') });
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
  if (item.kind === 'info') {
    // `__info__` is treated as non-selectable by the dropdown hook.
    return {
      id: '__info__',
      label: item.label,
      type: 'info',
    };
  }
  if (item.kind === 'subagent') {
    return subagentMentionToDropdownItem(item);
  }
  return fileToDropdownItem(item);
}
