// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CompactingIndicator } from './CompactingIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'chat.compactingSession' ? '正在压缩会话' : key),
  }),
}));

describe('CompactingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders dual spinner rings and internationalized text', () => {
    const { container, getByText } = render(<CompactingIndicator />);

    expect(getByText(/正在压缩会话/)).toBeTruthy();
    expect(container.querySelector('.compact-card__spinner-outer')).toBeTruthy();
    expect(container.querySelector('.compact-card__spinner-inner')).toBeTruthy();
    expect(container.querySelector('.compact-card--compacting')).toBeTruthy();
    expect(container.querySelector('.compact-card-wrapper--indicator')).toBeTruthy();
  });

  it('formats elapsed time correctly under and over 60 seconds', () => {
    const { getByText } = render(<CompactingIndicator />);

    expect(getByText('0s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(getByText('5s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(65000);
    });
    // Total 70s -> 1m 10s
    expect(getByText('1m 10s')).toBeTruthy();
  });

  it('calculates initial elapsed time based on startTime', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const startTime = now - 15000; // 15s ago

    const { getByText } = render(<CompactingIndicator startTime={startTime} />);

    expect(getByText('15s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(getByText('18s')).toBeTruthy();
  });

  it('cycles pulsing dots every 500ms', () => {
    const { container } = render(<CompactingIndicator />);
    const dotsEl = container.querySelector('.compact-card__dots');

    expect(dotsEl?.textContent).toBe('.');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(dotsEl?.textContent).toBe('..');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(dotsEl?.textContent).toBe('...');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(dotsEl?.textContent).toBe('.');
  });
});
