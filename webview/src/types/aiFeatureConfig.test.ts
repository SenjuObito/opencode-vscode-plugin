import { describe, expect, it } from 'vitest';
import {
  AI_FEATURE_PROVIDERS,
  DEFAULT_AI_FEATURE_MODELS,
  normalizeAiFeatureConfig,
  pickAutoAiFeatureProvider,
} from './aiFeatureConfig';

describe('normalizeAiFeatureConfig', () => {
  it('fills missing availability/models for every CLI provider', () => {
    const normalized = normalizeAiFeatureConfig({});
    for (const provider of AI_FEATURE_PROVIDERS) {
      expect(normalized.availability[provider]).toBe(false);
      expect(normalized.models[provider]).toBe(DEFAULT_AI_FEATURE_MODELS[provider]);
    }
    expect(normalized.provider).toBeNull();
  });

  it('preserves a valid provider and its availability flag', () => {
    const normalized = normalizeAiFeatureConfig({
      provider: 'opencode',
      effectiveProvider: 'opencode',
      resolutionSource: 'manual',
      models: { opencode: 'openai/gpt-5' },
      availability: { opencode: true },
    });
    expect(normalized.provider).toBe('opencode');
    expect(normalized.effectiveProvider).toBe('opencode');
    expect(normalized.availability.opencode).toBe(true);
    expect(normalized.models.opencode).toBe('openai/gpt-5');
  });

  it('fills defaults for providers missing from a partial payload', () => {
    const normalized = normalizeAiFeatureConfig({
      provider: 'opencode',
      models: {},
      availability: {},
    });
    expect(normalized.models.opencode).toBe(DEFAULT_AI_FEATURE_MODELS.opencode);
    expect(normalized.availability.opencode).toBe(false);
  });

  it('rejects unknown provider ids', () => {
    const normalized = normalizeAiFeatureConfig({
      provider: 'gemini' as never,
      effectiveProvider: 'gemini' as never,
    });
    expect(normalized.provider).toBeNull();
    expect(normalized.effectiveProvider).toBeNull();
  });
});

describe('pickAutoAiFeatureProvider', () => {
  it('returns opencode when it is available', () => {
    expect(pickAutoAiFeatureProvider({ opencode: true })).toBe('opencode');
    expect(pickAutoAiFeatureProvider({ opencode: false })).toBeNull();
  });

  it('prefers the current chat provider when available (prompt enhancer auto)', () => {
    expect(pickAutoAiFeatureProvider({ opencode: true }, 'opencode')).toBe('opencode');
    // An unknown preferred id falls back to opencode while it is available.
    expect(pickAutoAiFeatureProvider({ opencode: true }, 'unknown-cli')).toBe('opencode');
    expect(pickAutoAiFeatureProvider({ opencode: false }, 'unknown-cli')).toBeNull();
  });
});
