import { describe, expect, it } from 'vitest';
import { getMcpMessagePrefix, resolveInitialMcpProvider } from './providerSelection';

describe('MCP provider selection', () => {
  it('always resolves to opencode', () => {
    expect(resolveInitialMcpProvider()).toBe('opencode');
  });

  it('returns empty prefix for opencode', () => {
    expect(getMcpMessagePrefix()).toBe('');
  });
});
