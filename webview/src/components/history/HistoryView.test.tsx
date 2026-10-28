import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import HistoryView from './HistoryView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'history.totalSessions': `${options?.count} sessions · ${options?.total} messages`,
        'history.messageCount': `${options?.count} messages`,
        'history.selectMode': 'Select',
        'history.exitSelectMode': 'Exit selection',
        'history.selectedSessions': `${options?.count} selected`,
        'history.selectAll': 'Select all',
        'history.clearSelection': 'Clear',
        'history.deleteSelected': 'Delete selected',
        'history.confirmDeleteSelected': 'Confirm Delete',
        'history.deleteSelectedMessage': `Delete ${options?.count} selected sessions?`,
        'history.selectSession': 'Select session',
        'history.selectSessionWithTitle': `Select ${String(options?.title ?? '')}`,
        'history.searchPlaceholder': 'Search session titles...',
        'history.loadTimeout': 'Load history timed out',
        'history.retry': 'Retry',
        'history.loading': 'Loading history...',
        'history.loadFailed': 'Failed to load history',
        'history.favoriteSession': 'Favorite session',
        'history.unfavoriteSession': 'Unfavorite session',
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

vi.mock('../../utils/copyUtils', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const historyData: HistoryData = {
  success: true,
  total: 10,
  sessions: [
    {
      sessionId: 'session-one',
      title: 'First session',
      messageCount: 4,
      lastTimestamp: new Date().toISOString(),
      provider: 'claude',
    },
    {
      sessionId: 'session-two',
      title: 'Second session',
      messageCount: 6,
      lastTimestamp: new Date().toISOString(),
      provider: 'codex',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HistoryView multi-select', () => {
  it('deletes selected sessions after confirmation without loading them', () => {
    const onLoadSession = vi.fn();
    const onDeleteSession = vi.fn();
    const onDeleteSessions = vi.fn();

    render(
      <HistoryView
        historyData={historyData}
        currentProvider="claude"
        onLoadSession={onLoadSession}
        onDeleteSession={onDeleteSession}
        onDeleteSessions={onDeleteSessions}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select First session' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Second session' }));

    expect(screen.getByText('2 selected')).toBeTruthy();
    expect(onLoadSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete 2 selected sessions?')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(onDeleteSessions).toHaveBeenCalledTimes(1);
    expect(onDeleteSessions).toHaveBeenCalledWith(['session-one', 'session-two']);
    expect(onLoadSession).not.toHaveBeenCalled();
  });
});


describe('HistoryView favorite visibility', () => {
  it('marks favorited session actions for persistent display', () => {
    render(
      <HistoryView
        historyData={{
          ...historyData,
          sessions: [
            {
              ...historyData.sessions![0],
              isFavorited: true,
              favoritedAt: Date.now(),
            },
            historyData.sessions![1],
          ],
        }}
        currentProvider="claude"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
      />,
    );

    const favoritedButton = screen.getByRole('button', { name: 'Unfavorite session' });
    const unfavoritedButton = screen.getByRole('button', { name: 'Favorite session' });

    expect(favoritedButton.closest('.history-action-buttons')?.classList.contains('has-favorite')).toBe(true);
    expect(unfavoritedButton.closest('.history-action-buttons')?.classList.contains('has-favorite')).toBe(false);
  });
});

describe('HistoryView loading timeout and error retry', () => {
  it('renders retry button when error occurs and invokes onRetry', () => {
    const onRetry = vi.fn();
    render(
      <HistoryView
        historyData={{ success: false, error: 'Custom error message' }}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Custom error message')).toBeTruthy();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders timeout state and retry button after timeout duration', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(
      <HistoryView
        historyData={null}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Loading history...')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(13000);
    });

    expect(screen.getByText('Load history timed out')).toBeTruthy();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
