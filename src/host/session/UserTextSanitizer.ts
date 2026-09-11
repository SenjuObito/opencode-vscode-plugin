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
	'## IDE Context',
	"## User's Current IDE Context",
	'## Agent Role and Instructions',
];

const HEADER_LINE = /^##\s/;

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
	const kept: string[] = [];
	let skipping = false;
	for (const line of text.split(/\r?\n/)) {
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
	return kept.join('\n').trim();
}

/**
 * Whether anything would be removed.
 */
export function needsSanitize(text: string | null | undefined): boolean {
	if (!text) {
		return false;
	}
	for (const title of INJECTED_SECTION_TITLES) {
		if (text.includes(title)) {
			return true;
		}
	}
	return false;
}
