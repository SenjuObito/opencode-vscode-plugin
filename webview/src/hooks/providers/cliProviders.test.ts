import { describe, expect, it } from 'vitest';
import { normalizeCliPermissionMode } from './cliProviders';

describe('normalizeCliPermissionMode', () => {



  it('passes non-plan modes through unchanged for other providers', () => {
    expect(normalizeCliPermissionMode('acceptEdits', 'pi')).toBe('acceptEdits');
    expect(normalizeCliPermissionMode('bypassPermissions', 'grok')).toBe('bypassPermissions');
  });
});

