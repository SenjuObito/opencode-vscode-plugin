import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenIndicator } from './TokenIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percentage?: string }) => options?.percentage ?? key,
  }),
}));

describe('TokenIndicator', () => {
  it('clamps labels and ring geometry above 100 percent', () => {
    const { container } = render(<TokenIndicator percentage={145} usedTokens={2900} maxTokens={2000} />);

    expect(screen.getByText('100%')).toBeTruthy();
    const progressCircle = container.querySelector('.token-indicator-fill');
    expect(progressCircle?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(screen.getByText(/2.9k \/ 2k/)).toBeTruthy();
  });

  it('renders normal percentage and calculated stroke offset accurately', () => {
    const { container } = render(<TokenIndicator percentage={25} usedTokens={50000} maxTokens={200000} />);

    expect(screen.getByText('25%')).toBeTruthy();
    const progressCircle = container.querySelector('.token-indicator-fill');
    expect(progressCircle).toBeTruthy();
    expect(screen.getByText(/25.0% · 50k \/ 200k/)).toBeTruthy();
  });

  it('renders 0% correctly when unused', () => {
    const { container } = render(<TokenIndicator percentage={0} usedTokens={0} maxTokens={200000} />);

    expect(screen.getByText('0%')).toBeTruthy();
    const progressCircle = container.querySelector('.token-indicator-fill');
    expect(progressCircle).toBeTruthy();
  });
});
