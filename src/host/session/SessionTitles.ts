/**
 * Titles the opencode engine uses while a session has not been named yet:
 * `New session - <ISO>` / `Child session - <ISO>`.
 *
 * <p>Port of idea's `SessionTitles.java`: a placeholder means "not named yet",
 * not a conversation name. Every title path drops it and keeps the localized
 * placeholder until the engine's own title generator names the session.</p>
 */
const ENGINE_PLACEHOLDER_TITLE = /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isEnginePlaceholderTitle(title: string | null | undefined): boolean {
	return typeof title === 'string' && ENGINE_PLACEHOLDER_TITLE.test(title.trim());
}
