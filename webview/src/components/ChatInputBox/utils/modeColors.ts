/**
 * Accent colours for the chat input border.
 *
 * <p>opencode "modes" are primary agent ids. A mode's colour is resolved in this
 * order:</p>
 *
 * <ol>
 *   <li>the colour the agent declares in its config ({@code color: "#rrggbb"},
 *       returned by {@code /api/agent});</li>
 *   <li>the fixed accent of a built-in mode ({@code plan} keeps its orange,
 *       {@code winui-dev} its Windows blue);</li>
 *   <li>no accent: the mode keeps the theme's neutral border.</li>
 * </ol>
 *
 * <p>No colour is invented from the id: an undeclared custom agent should not
 * silently look like a different mode.</p>
 */

/** Built-in agents with a deliberate colour. */
const FIXED_ACCENTS: Record<string, string> = {
  plan: '#e07c24',
  // Windows/WinUI accent blue: distinguishes the custom WinUI agent from the
  // neutral build mode at a glance.
  'winui-dev': '#3b9eff',
};

/** opencode's agent colour schema: an opaque `#rrggbb`. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Accent colour for a mode, or undefined when the mode keeps the theme's
 * neutral treatment (build / undeclared custom agents / empty ids).
 *
 * @param id       the mode/agent id (legacy {@code default} means {@code build})
 * @param declared the agent's own {@code color} field, when the engine sent one
 */
export function getModeAccentColor(
  id: string | null | undefined,
  declared?: string | null,
): string | undefined {
  if (!id) return undefined;
  // Old persisted value 'default' is the legacy spelling of `build`.
  const normalized = id === 'default' ? 'build' : id;
  if (normalized === 'build') return undefined;

  // An explicit agent colour wins: it is the agent author's decision.
  if (declared && HEX_COLOR.test(declared)) {
    return declared;
  }

  return FIXED_ACCENTS[normalized];
}
