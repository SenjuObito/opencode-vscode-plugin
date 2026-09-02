/**
 * AI feature providers used by Prompt Enhancer settings.
 * Mirrors the main chat CLI selector (`AVAILABLE_PROVIDERS`).
 */
// opencode-only: claude / codex / grok / kimi / pi were removed.
export const AI_FEATURE_PROVIDERS = [
  'opencode',
] as const;

export type AiFeatureProvider = (typeof AI_FEATURE_PROVIDERS)[number];
export type AiFeatureResolutionSource = 'manual' | 'auto' | 'unavailable';

/** Default model id per provider — keep in sync with ChatInputBox/types defaults. */
export const DEFAULT_AI_FEATURE_MODELS: Record<AiFeatureProvider, string> = {
  opencode: 'opencode-default',
};

export type AiFeatureModels = Record<AiFeatureProvider, string>;
export type AiFeatureAvailability = Record<AiFeatureProvider, boolean>;

export interface AiFeatureConfig {
  provider: AiFeatureProvider | null;
  effectiveProvider: AiFeatureProvider | null;
  resolutionSource: AiFeatureResolutionSource;
  models: AiFeatureModels;
  availability: AiFeatureAvailability;
}

/**
 * Backend/partial payload shape accepted by normalizeAiFeatureConfig: models
 * and availability may carry only a subset of providers — the normalize step
 * fills the rest from defaults. The full AiFeatureConfig shape (opencode
 * required) is what consumers receive after normalization.
 */
export interface AiFeatureConfigInput {
  provider?: AiFeatureProvider | null;
  effectiveProvider?: AiFeatureProvider | null;
  resolutionSource?: AiFeatureResolutionSource;
  models?: Partial<AiFeatureModels> | null;
  availability?: Partial<AiFeatureAvailability> | null;
}

function emptyAvailability(value = false): AiFeatureAvailability {
  return {
    opencode: value,
  };
}

export function isAiFeatureProvider(value: unknown): value is AiFeatureProvider {
  return typeof value === 'string'
    && (AI_FEATURE_PROVIDERS as readonly string[]).includes(value);
}

function isResolutionSource(value: unknown): value is AiFeatureResolutionSource {
  return value === 'manual' || value === 'auto' || value === 'unavailable';
}

function normalizeModels(
  raw: Partial<Record<string, unknown>> | null | undefined,
  defaults: AiFeatureModels,
): AiFeatureModels {
  const models = { ...defaults };
  if (!raw || typeof raw !== 'object') {
    return models;
  }
  for (const provider of AI_FEATURE_PROVIDERS) {
    const value = raw[provider];
    if (typeof value === 'string' && value.trim()) {
      models[provider] = value.trim();
    }
  }
  return models;
}

function normalizeAvailability(
  raw: Partial<Record<string, unknown>> | null | undefined,
  defaults: AiFeatureAvailability,
): AiFeatureAvailability {
  const availability = { ...defaults };
  if (!raw || typeof raw !== 'object') {
    return availability;
  }
  for (const provider of AI_FEATURE_PROVIDERS) {
    if (provider in raw) {
      availability[provider] = Boolean(raw[provider]);
    }
  }
  return availability;
}

/**
 * Normalize backend/partial payloads so the settings selects always get a
 * complete controlled-component state (never missing availability/models).
 */
export function normalizeAiFeatureConfig(
  raw: AiFeatureConfigInput | null | undefined,
  defaults: AiFeatureConfig = {
    provider: null,
    effectiveProvider: 'opencode',
    resolutionSource: 'auto',
    models: { ...DEFAULT_AI_FEATURE_MODELS },
    availability: emptyAvailability(false),
  },
): AiFeatureConfig {
  if (raw == null) {
    return {
      ...defaults,
      models: { ...defaults.models },
      availability: { ...defaults.availability },
    };
  }

  return {
    // Explicit null from backend means auto mode; invalid values fall back to null.
    provider: raw.provider === null
      ? null
      : (isAiFeatureProvider(raw.provider) ? raw.provider : null),
    effectiveProvider: raw.effectiveProvider === null
      ? null
      : (isAiFeatureProvider(raw.effectiveProvider)
        ? raw.effectiveProvider
        : (raw.effectiveProvider === undefined ? defaults.effectiveProvider : null)),
    resolutionSource: isResolutionSource(raw.resolutionSource)
      ? raw.resolutionSource
      : defaults.resolutionSource,
    models: normalizeModels(raw.models, defaults.models),
    availability: normalizeAvailability(raw.availability, defaults.availability),
  };
}

/**
 * Resolve auto-mode provider.
 * Prefers `preferredProvider` when available (e.g. current chat CLI for prompt
 * enhancer), then falls back to opencode.
 */
export function pickAutoAiFeatureProvider(
  availability: AiFeatureAvailability,
  preferredProvider?: AiFeatureProvider | string | null,
): AiFeatureProvider | null {
  if (
    preferredProvider
    && isAiFeatureProvider(preferredProvider)
    && availability[preferredProvider]
  ) {
    return preferredProvider;
  }
  if (availability.opencode) return 'opencode';
  return null;
}
