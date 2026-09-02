import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChangelogDialog from './ChangelogDialog';
import type { ChangelogEntry } from '../version/changelog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

const entry: ChangelogEntry = {
  version: '1.2.0',
  date: '2026-09-01',
  content: { en: '## Features\n- A', zh: '## 新功能\n- 甲' },
};

describe('ChangelogDialog empty / out-of-range entries', () => {
  // React logs render errors to console.error; keep the run readable.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders an empty state instead of throwing when entries is empty', () => {
    // Regression: GitHub repo with no releases -> entries === [] used to reach
    // `resolveContent(undefined)` and throw during render, killing the webview.
    expect(() =>
      render(<ChangelogDialog isOpen onClose={() => {}} entries={[]} />),
    ).not.toThrow();
    expect(screen.getByText('changelog.empty')).toBeTruthy();
  });

  it('renders an empty state while loading with no entries yet', () => {
    expect(() =>
      render(<ChangelogDialog isOpen onClose={() => {}} entries={[]} loading />),
    ).not.toThrow();
  });

  it('clamps currentPage when entries shrink below the active page', () => {
    // Regression: switching from a long bundled changelog to a short releases
    // list left currentPage out of range -> entry === undefined -> crash.
    const { rerender } = render(
      <ChangelogDialog isOpen onClose={() => {}} entries={[entry, entry, entry]} initialPage={2} />,
    );
    expect(screen.getByText('v1.2.0')).toBeTruthy();

    expect(() =>
      rerender(<ChangelogDialog isOpen onClose={() => {}} entries={[entry]} initialPage={2} />),
    ).not.toThrow();
    expect(screen.getByText('v1.2.0')).toBeTruthy();
  });

  it('does not render version/date when the resolved entry is missing', () => {
    render(<ChangelogDialog isOpen onClose={() => {}} entries={[]} />);
    expect(screen.queryByText('v1.2.0')).toBeNull();
  });

  it('still renders content for a normal entry', () => {
    render(<ChangelogDialog isOpen onClose={() => {}} entries={[entry]} />);
    expect(screen.getByText('v1.2.0')).toBeTruthy();
    expect(screen.getByText('2026-09-01')).toBeTruthy();
  });
});
