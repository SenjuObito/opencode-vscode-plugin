import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueue } from './MessageQueue';

const item = {
  id: 'q1',
  content: 'queued prompt',
  createdAt: 1,
};

describe('MessageQueue', () => {
  it('shows the continue button when the queue is paused', () => {
    const onResume = vi.fn();
    render(
      <MessageQueue
        queue={[item]}
        paused
        onRemove={() => {}}
        onResume={onResume}
      />,
    );

    fireEvent.click(screen.getByText('继续发送'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows the continue button when a send failed', () => {
    const onResume = vi.fn();
    render(
      <MessageQueue
        queue={[item]}
        error={{ itemId: 'q1', message: 'Nothing to compact yet' }}
        onRemove={() => {}}
        onResume={onResume}
      />,
    );

    expect(screen.getByText('Nothing to compact yet')).toBeTruthy();
    fireEvent.click(screen.getByText('继续发送'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('keeps the button reachable when the failure left no waiting item', () => {
    render(
      <MessageQueue
        queue={[]}
        error={{ itemId: 'q1', message: 'send failed' }}
        onRemove={() => {}}
        onResume={() => {}}
      />,
    );

    expect(screen.getByText('继续发送')).toBeTruthy();
  });

  it('does not show the button when the queue is neither paused nor failed', () => {
    render(
      <MessageQueue
        queue={[item]}
        onRemove={() => {}}
        onResume={() => {}}
      />,
    );

    expect(screen.queryByText('继续发送')).toBeNull();
  });
});
