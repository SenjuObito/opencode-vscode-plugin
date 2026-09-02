import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { WelcomeScreen } from './WelcomeScreen';

vi.mock('../BlinkingLogo', () => ({
  BlinkingLogo: () => <div data-testid="blinking-logo" />,
}));

vi.mock('../AnimatedText', () => ({
  AnimatedText: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../../version/version', () => ({
  APP_VERSION: '0.0.0-test',
}));

describe('WelcomeScreen', () => {
  const t = ((key: string, options?: Record<string, unknown>) => {
    if (key === 'chat.sendMessage') {
      return `给 ${String(options?.provider ?? '')} 发送消息`;
    }
    if (key === 'providers.opencode.label') {
      return 'OpenCode';
    }
    return key;
  }) as unknown as TFunction;

  it('uses the translated OpenCode provider label in the welcome copy', () => {
    render(
      <WelcomeScreen
        currentProvider="opencode"
        t={t}
        onProviderChange={vi.fn()}
      />,
    );

    expect(screen.getByText('给 OpenCode 发送消息')).toBeTruthy();
  });

  it('falls back to the raw provider id for unknown providers', () => {
    render(
      <WelcomeScreen
        currentProvider="some-future-cli"
        t={t}
        onProviderChange={vi.fn()}
      />,
    );

    expect(screen.getByText('给 some-future-cli 发送消息')).toBeTruthy();
  });
});
