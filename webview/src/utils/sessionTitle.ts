/**
 * Titles the opencode engine uses while a session has not been named yet:
 * `New session - <ISO>` / `Child session - <ISO>`.
 *
 * They are placeholders, not conversation names. Showing one would put a raw
 * timestamp on the tab and then replace it seconds later, so every title path
 * drops them and keeps the localized placeholder until the engine names the
 * session — the engine's own title generator is what produces the real name.
 */
const ENGINE_PLACEHOLDER_TITLE = /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isEnginePlaceholderTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && ENGINE_PLACEHOLDER_TITLE.test(title.trim());
}
