// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BETA_PROVIDER_NOTICE_KEY } from '../../../utils/betaProviderNotice';
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
        'providers.grok.label': 'Grok CLI',
        'providers.kimi.label': 'Kimi CLI',
        'providers.opencode.label': 'OpenCode',
        'providers.pi.label': 'PI CLI',
        'providers.beta.badge': 'Beta',
        'providers.beta.title': 'Beta Feature',
        'providers.beta.message':
          'This feature is still in Beta. If you encounter any bugs, please report them to the author promptly.',
        'common.gotIt': 'Got it',
        'settings.provider.featureComingSoon': 'Coming soon',
        'config.switchProvider': 'Switch provider',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return map[key] ?? (defaultValue || key);
    },
  }),
}));

describe('ProviderSelect Beta badge and first-click notice', () => {
  beforeEach(() => {
    localStorage.removeItem(BETA_PROVIDER_NOTICE_KEY);
    window.sendToJava = vi.fn();
    window.updateCodexSubscriptionQuota = undefined;
  });

  it('renders no Beta badges for the opencode-only provider list', () => {
    render(<ProviderSelect value="opencode" />);
    fireEvent.click(screen.getByRole('button'));

    // Only opencode remains and it is not flagged beta.
    const badges = screen.queryAllByText('Beta');
    expect(badges).toHaveLength(0);

    const row = document.querySelector('[data-provider-id="opencode"]');
    expect(row?.querySelector('.provider-beta-badge')).toBeNull();
  });

  it('switches to opencode on click without showing a beta notice', () => {
    const onChange = vi.fn();
    render(<ProviderSelect value="claude" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));
    const row = document.querySelector('[data-provider-id="opencode"]')!;
    fireEvent.click(row);

    expect(onChange).toHaveBeenCalledWith('opencode');
    expect(screen.queryByText('Beta Feature')).toBeNull();
  });
});
