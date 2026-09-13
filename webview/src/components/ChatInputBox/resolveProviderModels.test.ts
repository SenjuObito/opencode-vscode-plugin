import { describe, expect, it } from 'vitest';
import { resolveProviderModels } from './resolveProviderModels';

describe('resolveProviderModels', () => {
  it('returns dynamic cliModels directly for OpenCode', () => {
    const models = [{ id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' }];
    expect(
      resolveProviderModels({
        cliModels: models,
      }),
    ).toEqual(models);
  });
});

