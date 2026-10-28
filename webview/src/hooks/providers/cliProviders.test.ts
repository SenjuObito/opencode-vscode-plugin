import { describe, expect, it } from 'vitest';
import { normalizeCliPermissionMode } from './cliProviders';

describe('normalizeCliPermissionMode', () => {



  it('passes non-plan modes through unchanged', () => {
    expect(normalizeCliPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(normalizeCliPermissionMode('bypassPermissions')).toBe('bypassPermissions');
  });
});

