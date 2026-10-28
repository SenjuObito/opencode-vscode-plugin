// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMessageQueue } from './useMessageQueue';

describe('useMessageQueue', () => {
  it('initializes with an empty queue', () => {
    const onExecute = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue({ isLoading: false, isCompacting: false, onExecute }),
    );

    expect(result.current.queue).toEqual([]);
    expect(result.current.hasQueuedMessages).toBe(false);
  });

  it('enqueues messages and removes them via dequeue', () => {
    const onExecute = vi.fn();
    const { result } = renderHook(() =>
      useMessageQueue({ isLoading: true, isCompacting: false, onExecute }),
    );

    act(() => {
      result.current.enqueue('Hello world');
      result.current.enqueue('/compact');
      result.current.enqueue('$ls -la');
    });

    expect(result.current.queue.length).toBe(3);
    expect(result.current.queue[0].content).toBe('Hello world');
    expect(result.current.queue[1].content).toBe('/compact');
    expect(result.current.queue[2].content).toBe('$ls -la');
    expect(result.current.hasQueuedMessages).toBe(true);

    const secondId = result.current.queue[1].id;
    act(() => {
      result.current.dequeue(secondId);
    });

    expect(result.current.queue.length).toBe(2);
    expect(result.current.queue[0].content).toBe('Hello world');
    expect(result.current.queue[1].content).toBe('$ls -la');
  });

  it('automatically dequeues and executes messages in FIFO order when isLoading transitions to false', async () => {
    vi.useFakeTimers();
    const onExecute = vi.fn();
    let isLoading = true;

    const { result, rerender } = renderHook(
      ({ loading }) => useMessageQueue({ isLoading: loading, isCompacting: false, onExecute }),
      { initialProps: { loading: isLoading } },
    );

    act(() => {
      result.current.enqueue('First message');
      result.current.enqueue('/compact');
    });

    expect(result.current.queue.length).toBe(2);
    expect(onExecute).not.toHaveBeenCalled();

    // Transition loading to false
    isLoading = false;
    rerender({ loading: isLoading });

    // Queue item popped immediately
    expect(result.current.queue.length).toBe(1);

    // After timer runs, onExecute should be called with the first message
    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(onExecute).toHaveBeenCalledWith('First message', undefined);
    vi.useRealTimers();
  });

  it('automatically dequeues and executes next message when isCompacting transitions to false', async () => {
    vi.useFakeTimers();
    const onExecute = vi.fn();
    let isCompacting = true;

    const { result, rerender } = renderHook(
      ({ compacting }) => useMessageQueue({ isLoading: false, isCompacting: compacting, onExecute }),
      { initialProps: { compacting: isCompacting } },
    );

    act(() => {
      result.current.enqueue('/compact');
      result.current.enqueue('$git status');
    });

    expect(result.current.queue.length).toBe(2);

    // Transition isCompacting to false
    isCompacting = false;
    rerender({ compacting: isCompacting });

    expect(result.current.queue.length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(onExecute).toHaveBeenCalledWith('/compact', undefined);
    vi.useRealTimers();
  });
});
