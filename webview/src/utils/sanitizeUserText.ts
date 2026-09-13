/**
 * Strips plugin-injected context sections from persisted user text.
 *
 * Mirrors the Java-side UserTextSanitizer: the send path appends generated
 * markdown sections (## IDE Context, ## Referenced Files, agent instructions,
 * …) to the message text for the model; that text is persisted verbatim by
 * opencode. The history restore path (OpenCodeMessageConverter) cleans new
 * payloads, but session titles already written into the local index cache
 * keep the injected sections — this util keeps the display layer consistent
 * for those legacy entries.
 *
 * Line-based state machine so the semantics stay identical to the Java regex
 * (`^## Title` … up to the next `## ` heading or end of text): an injected
 * title line and everything after it are dropped until the next heading of
 * any kind; a user-authored heading ends the injected section and is kept.
 * Idempotent: clean text passes through unchanged.
 */

const INJECTED_SECTION_TITLES = new Set([
  '## Workspace Context',
  '## Project Modules',
  '## Active Terminal Session',
  '## Referenced Files',
  '## Attached Files',
  '## IDE Context',
  "## User's Current IDE Context",
  '## Agent Role and Instructions',
]);

const HEADER_LINE = /^##\s/;
const ATTACHMENT_BLOCK_REGEX = /<attachment\b[^>]*>[\s\S]*?(?:<\/attachment>|$)/gi;

const FALLBACK_TEXTS = new Set([
  'Please review the attached file(s).',
  'Please analyze the attached image(s).',
]);

/**
 * Remove injected sections and trim leftover separator whitespace.
 * Returns '' for null/undefined input.
 */
export function sanitizeUserText(text: string | null | undefined): string {
  if (!text) return '';
  // 1. Strip inlined <attachment> blocks first so internal markdown headers don't interfere
  const withoutAttachments = text.replace(ATTACHMENT_BLOCK_REGEX, '');

  // 2. Strip standard ## injected context sections
  const kept: string[] = [];
  let skipping = false;
  for (const line of withoutAttachments.split(/\r?\n/)) {
    const isHeader = HEADER_LINE.test(line);
    if (isHeader && INJECTED_SECTION_TITLES.has(line.trim())) {
      // Drop the injected title and everything inside the section.
      skipping = true;
      continue;
    }
    if (isHeader) {
      // Any other heading ends the injected section and is user content.
      skipping = false;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  const result = kept.join('\n').trim();

  // 3. Drop synthetic fallback prompt text for attachment-only turns
  if (FALLBACK_TEXTS.has(result)) {
    return '';
  }
  return result;
}
