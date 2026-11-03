import type { ClaudeMessage } from '../types';

/**
 * Raw-block helpers shared by the transcript and the streaming callbacks.
 *
 * <p>They live outside both so the transcript can merge a turn's final content
 * without importing the event layer (and the event layer can describe the
 * merged result without owning the transcript).</p>
 */

/** Safely extract content blocks from `raw` (object or JSON string). */
export function getRawContentBlocks(raw: unknown): unknown[] {
  if (!raw) return [];
  let parsedRaw: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsedRaw || typeof parsedRaw !== 'object') return [];
  const content = (parsedRaw as { message?: { content?: unknown }; content?: unknown }).message?.content
    ?? (parsedRaw as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/** Whether the raw field contains any content blocks. */
export function rawHasContent(raw: unknown): boolean {
  return getRawContentBlocks(raw).length > 0;
}

/** Whether a streaming assistant bubble has renderable content yet. */
export function streamingBubbleHasContent(message: ClaudeMessage): boolean {
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    return true;
  }
  return rawHasContent(message.raw);
}

/** tool_use ids carried by tool_result blocks inside one message. */
export function toolResultIdsOf(message: ClaudeMessage | undefined): string[] {
  const ids: string[] = [];
  for (const block of getRawContentBlocks(message?.raw)) {
    const typed = block as { type?: string; tool_use_id?: string };
    if (typed?.type === 'tool_result' && typed.tool_use_id) ids.push(typed.tool_use_id);
  }
  return ids;
}

/** All tool_use ids that already have a result anywhere in the list. */
export function collectToolResultIds(messages: ClaudeMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const id of toolResultIdsOf(message)) ids.add(id);
  }
  return ids;
}

type TextBlock = { type: 'text'; text: string };

/** Total text length of the raw text blocks, for completeness comparison. */
export function getTextLenFromRaw(raw: unknown): number {
  const blocks = getRawContentBlocks(raw);
  return blocks
    .filter((block): block is TextBlock => (block as TextBlock)?.type === 'text' && typeof (block as TextBlock).text === 'string')
    .reduce((sum, block) => sum + block.text.length, 0);
}
