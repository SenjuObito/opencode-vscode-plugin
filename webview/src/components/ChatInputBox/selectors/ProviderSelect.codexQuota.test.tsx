// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSelect } from './ProviderSelect';

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const map: Record<string, string> = {
        'providers.claude.label': 'Claude Code',
        'providers.codex.label': 'Codex',
        'providers.opencode.label': 'OpenCode',
        'settings.provider.featureComingSoon': 'Coming soon',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      const interpolated = defaultValue.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
        const value = options && typeof options === 'object' ? (options as Record<string, unknown>)[token] : undefined;
        return value == null ? '' : String(value);
      });
      return map[key] ?? (interpolated || key);
    },
  }),
}));

describe('ProviderSelect with opencode-only providers', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateCodexSubscriptionQuota = undefined;
  });

  it('renders only the opencode provider row', () => {
    render(<ProviderSelect value="opencode" />);

    fireEvent.click(screen.getByRole('button'));

    const rows = document.querySelectorAll('[data-provider-id]');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-provider-id')).toBe('opencode');
    // The button label also reads "OpenCode"; the row is the one with the id.
    expect(rows[0].textContent).toContain('OpenCode');
  });

  it('never renders the Codex quota submenu (Codex was removed)', () => {
    render(<ProviderSelect value="opencode" />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.queryByText('Codex quota')).toBeNull();
    expect(screen.queryByText('5h usage')).toBeNull();
    expect(window.sendToJava).not.toHaveBeenCalledWith('get_codex_subscription_quota:');
  });

  it('selects the opencode provider on click', () => {
    const onChange = vi.fn();
    render(<ProviderSelect value="opencode" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));
    const row = document.querySelector('[data-provider-id="opencode"]')!;
    fireEvent.click(row);

    expect(onChange).toHaveBeenCalledWith('opencode');
  });
});
