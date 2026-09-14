import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RevertPlaceholderBar from './RevertPlaceholderBar';
import type { ClaudeMessage } from '../../types';

vi.mock('../MessageItem', () => ({
  MessageItem: ({ message }: { message: ClaudeMessage }) => (
    <div data-testid="mock-message-item">{message.content}</div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.revertPlaceholderCount') return `${options?.count} messages undone`;
      return key;
    },
    i18n: { language: 'zh' },
  }),
}));

describe('RevertPlaceholderBar', () => {
  it('renders the collapsed placeholder with a count and restore action', () => {
    const onRestore = vi.fn();
    render(
      <RevertPlaceholderBar
        count={3}
        previews={[
          { role: 'user', text: 'hello' },
          { role: 'assistant', text: 'world' },
        ]}
        onRestore={onRestore}
      />,
    );

    expect(screen.getByText('3 messages undone')).toBeTruthy();
    expect(screen.getByTitle('chat.redoTooltip')).toBeTruthy();

    fireEvent.click(screen.getByTitle('chat.redoTooltip'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('expands to show the reverted message previews and collapses back', () => {
    render(
      <RevertPlaceholderBar
        count={2}
        previews={[
          { role: 'user', text: 'first question' },
          { role: 'assistant', text: 'some answer' },
        ]}
        onRestore={vi.fn()}
      />,
    );

    // Preview hidden until expanded
    expect(screen.queryByText('first question')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'chat.revertExpand' }));
    expect(screen.getByText('first question')).toBeTruthy();
    expect(screen.getByText('some answer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat.revertCollapse' }));
    expect(screen.queryByText('first question')).toBeNull();
  });

  it('renders full MessageItems when revertedMessages is provided', () => {
    const sampleMessages: ClaudeMessage[] = [
      { id: 'm1', type: 'user', content: 'full question text' },
      { id: 'm2', type: 'assistant', content: 'full answer text' },
    ];

    render(
      <RevertPlaceholderBar
        count={2}
        revertedMessages={sampleMessages}
        onRestore={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.revertExpand' }));
    expect(screen.getByTestId('reverted-messages-container')).toBeTruthy();
    expect(screen.getByText('full question text')).toBeTruthy();
    expect(screen.getByText('full answer text')).toBeTruthy();
  });

  it('disables the expand toggle when there is nothing to preview', () => {
    render(<RevertPlaceholderBar count={0} previews={[]} onRestore={vi.fn()} />);

    const expandBtn = screen.getByRole('button', { name: 'chat.revertExpand' });
    expect((expandBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

