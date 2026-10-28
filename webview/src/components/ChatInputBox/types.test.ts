import { describe, expect, it } from 'vitest';
import {
  OPENCODE_DEFAULT_MODEL_ID,
  OPENCODE_MODELS,
  getAvailableReasoningLevels,
  getRecommendedReasoningEffort,
} from './types';

describe('OPENCODE_DEFAULT_MODEL_ID', () => {
  it('is defined and non-empty', () => {
    expect(OPENCODE_DEFAULT_MODEL_ID).toBe('opencode-default');
  });
});

describe('OPENCODE_MODELS', () => {
  it('contains the default model', () => {
    expect(OPENCODE_MODELS.some((m) => m.id === OPENCODE_DEFAULT_MODEL_ID)).toBe(true);
  });

  it('has valid structure for all models', () => {
    for (const model of OPENCODE_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.label).toBeTruthy();
    }
  });
});

describe('getAvailableReasoningLevels', () => {
  it('keeps the legacy list when variants are unknown', () => {
    // opencode v1 ships no variant catalog: keep the previous behaviour without default.
    const levels = getAvailableReasoningLevels('opencode', 'some-model', undefined);
    expect(levels.map((l) => l.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('returns nothing when the model explicitly has no variants', () => {
    expect(getAvailableReasoningLevels('opencode', 'mimo-v2.6-flash-free', [])).toEqual([]);
  });

  it('filters by modelVariants when provided', () => {
    const levels = getAvailableReasoningLevels('claude', 'claude-opus-4-8', ['low', 'medium', 'high']);
    expect(levels.map((l) => l.id)).toEqual(['low', 'medium', 'high']);
  });

  it('renders only the variants the model offers', () => {
    const levels = getAvailableReasoningLevels('opencode', 'deepseek', ['low', 'high', 'max']);
    expect(levels.map((l) => l.id)).toEqual(['low', 'high', 'max']);
    // Known ids keep their translated label and icon.
    expect(levels[0].label).toBe('Low');
  });

  it('renders the catalog-provided none variant with a real label', () => {
    const levels = getAvailableReasoningLevels('opencode', 'nemotron', ['none', 'xhigh']);
    expect(levels.map((l) => l.id)).toEqual(['none', 'xhigh']);
    expect(levels[0].label).toBe('None');
  });

  it('offers only the model variant for a model with a single variant', () => {
    const levels = getAvailableReasoningLevels('opencode', 'glm', ['high']);
    expect(levels[0].id).toBe('high');
    expect(levels.map((l) => l.id)).toEqual(['high']);
  });

  it('strips default when a catalog happens to list it', () => {
    const levels = getAvailableReasoningLevels('opencode', 'odd-model', ['default', 'low']);
    expect(levels.map((l) => l.id)).toEqual(['low']);
  });
});

describe('getRecommendedReasoningEffort', () => {
  it('prefers a thinking level over the none variant', () => {
    expect(getRecommendedReasoningEffort(['none', 'high', 'max'])).toBe('high');
  });

  it('keeps none when it is the only variant', () => {
    expect(getRecommendedReasoningEffort(['none'])).toBe('none');
  });

  it('prefers low for the DeepSeek Flash catalog', () => {
    expect(getRecommendedReasoningEffort(['none', 'low', 'high', 'max'])).toBe('low');
  });
});
