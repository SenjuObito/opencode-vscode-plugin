import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Headless CLI providers that share opencode-style marker streaming (no npm SDK).
 * opencode is the only remaining CLI in this fork; grok / kimi / pi were removed.
 */
export const CLI_ONLY_PROVIDERS = new Set(['opencode']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

/** Plan mode is not exposed for CLI providers (always-approve / auto permission). */
export function normalizeCliPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === 'plan' ? 'default' : mode;
}
