import { describe, expect, it } from 'vitest';
import { resolveProviderModels } from './resolveProviderModels';
import { CODEX_MODELS, CLAUDE_MODELS } from './types';

describe('resolveProviderModels', () => {
  it('does not dump static fallback as "catalog" for Codex — keeps built-ins + customs', () => {
    const customs = [{ id: 'my-gpt', label: 'My GPT' }];
    const result = resolveProviderModels({
      provider: 'codex',
      cliModels: CODEX_MODELS, // static fallback masquerading as catalog
      cliCatalogHasEntries: false,
      codexCustomModels: customs,
    });
    expect(result.map((m) => m.id)).toEqual([
      'my-gpt',
      ...CODEX_MODELS.map((m) => m.id),
    ]);
  });

  it('merges real Codex catalog entries with customs and built-ins', () => {
    const catalog = [{ id: 'kimi-k3', label: 'Kimi K3' }];
    const customs = [{ id: 'my-gpt', label: 'My GPT' }];
    const result = resolveProviderModels({
      provider: 'codex',
      cliModels: catalog,
      cliCatalogHasEntries: true,
      codexCustomModels: customs,
    });
    expect(result.map((m) => m.id)[0]).toBe('my-gpt');
    expect(result.map((m) => m.id)).toContain('kimi-k3');
    expect(result.map((m) => m.id)).toContain(CODEX_MODELS[0].id);
  });

  it('returns cliModels for OpenCode when no customs are configured', () => {
    const models = [{ id: 'auto', label: 'Auto' }];
    expect(
      resolveProviderModels({
        provider: 'opencode',
        cliModels: models,
        cliCatalogHasEntries: true,
      }),
    ).toEqual(models);
  });

  it('puts opencode customs first and dedupes against cli catalog by id and label', () => {
    const customs = [
      { id: 'my-model', label: 'My Model' },
      { id: 'dup-label', label: 'Auto' },
    ];
    const catalog = [
      { id: 'dup-label', label: 'Auto (catalog)' },
      { id: 'auto', label: 'OpenCode Auto' },
      { id: 'my-model', label: 'My Model (catalog)' },
    ];
    const result = resolveProviderModels({
      provider: 'opencode',
      cliModels: catalog,
      cliCatalogHasEntries: true,
      claudeCustomModels: customs,
    });
    expect(result.map((m) => m.id)).toEqual(['my-model', 'dup-label', 'auto']);
  });

  it('collapses opencode catalog entries whose labels match a custom model', () => {
    const result = resolveProviderModels({
      provider: 'opencode',
      cliModels: [{ id: 'auto', label: 'Auto' }],
      cliCatalogHasEntries: true,
      claudeCustomModels: [{ id: 'dup-label', label: 'Auto' }],
    });
    expect(result.map((m) => m.id)).toEqual(['dup-label']);
  });

  it('puts Claude customs first and keeps built-ins', () => {
    const customs = [{ id: 'my-claude', label: 'My Claude' }];
    const result = resolveProviderModels({
      provider: 'claude',
      cliModels: [],
      claudeCustomModels: customs,
    });
    expect(result[0]).toEqual(customs[0]);
    expect(result.map((m) => m.id)).toContain(CLAUDE_MODELS[0].id);
  });
});
