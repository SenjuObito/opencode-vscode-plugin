import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CliSection from './index';

const translations: Record<string, string> = {
  'settings.cli.listTitle': 'Local CLI tools',
  'settings.cli.summary': '{{installed}} / {{total}} installed',
  'settings.cli.moreComingSoon': 'More coming soon',
  'settings.cli.hint': 'hint',
  'settings.cli.refresh': 'Re-check',
  'settings.cli.retry': 'Retry',
  'settings.cli.loading': 'Loading',
  'settings.cli.loadFailed': 'Failed',
  'settings.cli.status.installed': 'Installed',
  'settings.cli.status.notInstalled': 'Not installed',
  'settings.cli.viewInstallGuide': 'Install guide',
  'settings.cli.howToInstall': 'Install guide',
  'settings.cli.copy': 'Copy',
  'settings.cli.copyPath': 'Copy path',
  'settings.cli.copied': 'Copied',
  'settings.cli.copyFailed': 'Copy failed',
  'settings.cli.tools.opencode.name': 'OpenCode',
  'settings.cli.tools.opencode.description': 'OpenCode desc',
  'settings.cli.installDialog.title': 'Install {{name}}',
  'settings.cli.installDialog.lead': 'Lead {{name}} {{binary}}',
  'settings.cli.installDialog.stepOpenTerminal': 'Open terminal',
  'settings.cli.installDialog.stepRunCommand': 'Run command',
  'settings.cli.installDialog.stepVerify': 'Verify {{binary}}',
  'settings.cli.installDialog.stepReturn': 'Return',
  'settings.cli.installDialog.primaryCommand': 'Primary',
  'settings.cli.installDialog.windowsCommand': 'Windows',
  'settings.cli.installDialog.altCommand': 'Alt',
  'settings.cli.installDialog.openDocs': 'Docs',
  'common.close': 'Close',
  'common.gotIt': 'Got it',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key] ?? key;
      if (!options) return template;
      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template,
      );
    },
  }),
}));

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

describe('CliSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    window.updateCliStatus = undefined;
  });

  afterEach(() => {
    window.sendToJava = undefined;
    window.updateCliStatus = undefined;
  });

  it('requests CLI status on mount', async () => {
    render(<CliSection />);
    await waitFor(() => {
      expect(window.sendToJava).toHaveBeenCalledWith('get_cli_status:');
    });
  });

  it('renders installed and missing CLI tools from backend payload', async () => {
    render(<CliSection />);

    await act(async () => {
      window.updateCliStatus?.(JSON.stringify({
        opencode: {
          id: 'opencode',
          name: 'OpenCode',
          binaryName: 'opencode',
          installed: true,
          version: '0.9.0',
          path: '/usr/local/bin/opencode',
        },
      }));
    });

    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('v0.9.0')).toBeTruthy();
    expect(screen.getByText('/usr/local/bin/opencode')).toBeTruthy();
    expect(screen.getByText('More coming soon')).toBeTruthy();
  });

  it('opens install guide dialog without auto-installing', async () => {
    render(<CliSection />);

    await act(async () => {
      window.updateCliStatus?.(JSON.stringify({
        opencode: { id: 'opencode', name: 'OpenCode', binaryName: 'opencode', installed: false },
      }));
    });

    const guideButtons = screen.getAllByText('Install guide');
    fireEvent.click(guideButtons[0]);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/curl -fsSL https:\/\/opencode\.ai\/install \| bash/)).toBeTruthy();
    // Never triggers install via host bridge
    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.every((c) => !c.includes('install'))).toBe(true);
  });
});
