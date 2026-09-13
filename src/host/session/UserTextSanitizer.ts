/**
 * Strips plugin-injected context sections from user message text.
 *
 * Port of cc-gui `session/UserTextSanitizer.java`.
 * On send, the plugin appends generated markdown sections (IDE context,
 * referenced files, agent instructions, …) to the text part so the model
 * receives them. That text is persisted verbatim by opencode, so without
 * this pass a history reload or session restore would render the injected
 * sections inside the user bubble.
 */

const INJECTED_SECTION_TITLES = [
	'## Workspace Context',
	'## Project Modules',
	'## Active Terminal Session',
	'## Referenced Files',
	'## Attached Files',
	'## IDE Context',
	"## User's Current IDE Context",
	'## Agent Role and Instructions',
];

const HEADER_LINE = /^##\s/;

const ATTACHMENT_BLOCK_REGEX = /<attachment\b[^>]*>[\s\S]*?(?:<\/attachment>|$)/gi;

const FALLBACK_TEXTS = new Set([
	'Please review the attached file(s).',
	'Please analyze the attached image(s).',
]);

/**
 * Remove injected sections and trim leftover separator whitespace.
 *
 * @param text raw persisted user text, may be null/undefined
 * @returns text without injected sections; never null/undefined
 */
export function sanitizeUserText(text: string | null | undefined): string {
	if (!text) {
		return '';
	}
	// 1. Strip inlined <attachment> blocks first so internal markdown headers don't interfere
	const withoutAttachments = text.replace(ATTACHMENT_BLOCK_REGEX, '');

	// 2. Strip standard ## injected context sections
	const kept: string[] = [];
	let skipping = false;
	for (const line of withoutAttachments.split(/\r?\n/)) {
		const isHeader = HEADER_LINE.test(line);
		if (isHeader && INJECTED_SECTION_TITLES.includes(line.trim())) {
			skipping = true;
			continue;
		}
		if (isHeader) {
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

/**
 * Whether anything would be removed.
 */
export function needsSanitize(text: string | null | undefined): boolean {
	if (!text) {
		return false;
	}
	if (ATTACHMENT_BLOCK_REGEX.test(text) || FALLBACK_TEXTS.has(text.trim())) {
		return true;
	}
	for (const title of INJECTED_SECTION_TITLES) {
		if (text.includes(title)) {
			return true;
		}
	}
	return false;
}
