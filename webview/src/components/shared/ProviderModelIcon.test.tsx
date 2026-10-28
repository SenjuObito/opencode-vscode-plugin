import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderModelIcon } from './ProviderModelIcon';

describe('ProviderModelIcon', () => {
  it('renders the Xiaomi MiMo icon for MiMo model IDs on Claude-compatible providers', () => {
    const { container } = render(
      <ProviderModelIcon providerId="claude" modelId="mimo-v2.5-pro" colored />,
    );

    expect(container.querySelector('[aria-label="XiaomiMiMo"]')).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('XiaomiMiMo');
  });

  it('renders the official Pi geometric mark for the pi CLI provider', () => {
    const { container } = render(
      <ProviderModelIcon providerId="pi" size={16} colored />,
    );

    expect(container.querySelector('[aria-label="Pi"]')).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('Pi');
    // Official path data from https://pi.dev/logo-auto.svg (P block + i-dot)
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    expect(paths[0]?.getAttribute('d')).toContain('165.29');
    expect(paths[1]?.getAttribute('d')).toContain('517.36');
  });

  it('opencode 的彩色分支渲染 Aero 玻璃徽章（不再只剩单色方块）', () => {
    const { container } = render(<ProviderModelIcon providerId="opencode" size={58} colored />);

    // 徽章 = 外框 + 挖空 + 全息内核 三个 rect，外加一层渐变描边
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 44 44');
    expect(svg?.querySelectorAll('rect').length).toBe(4);
    expect(svg?.querySelector('linearGradient#aero-ob-hologram')).toBeTruthy();
  });

  it('opencode 的单色分支仍是 lobehub 的 mono 图标', () => {
    const colored = render(<ProviderModelIcon providerId="opencode" size={16} colored />);
    const mono = render(<ProviderModelIcon providerId="opencode" size={16} />);

    expect(colored.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 44 44');
    expect(mono.container.querySelector('svg')?.getAttribute('viewBox')).not.toBe('0 0 44 44');
  });
});
