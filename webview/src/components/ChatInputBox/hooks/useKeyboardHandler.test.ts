import { renderHook } from '@testing-library/react';
import type React from 'react';
import { useKeyboardHandler } from './useKeyboardHandler.js';
import { getNextPrimaryMode } from '../providers/agentProvider';

vi.mock('../providers/agentProvider', () => ({
  getNextPrimaryMode: vi.fn(() => 'plan'),
}));

function reactKeyEvent({
  key,
  metaKey = false,
  ctrlKey = false,
  shiftKey = false,
  isComposing = false,
}: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}) {
  const e = {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    nativeEvent: { isComposing, key },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  return e as unknown as React.KeyboardEvent<HTMLDivElement>;
}

describe('useKeyboardHandler', () => {
  it('sends on Enter (enter mode) when allowed', () => {
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        daemonStatusLoaded: true,
        sdkInstalled: true,
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        dollarCommandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const e = reactKeyEvent({ key: 'Enter' });
    result.current.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(submittedOnEnterRef.current).toBe(true);
  });


  it('cycles the live primary agents on Shift+Tab', () => {
    const onModeSelect = vi.fn();
    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        daemonStatusLoaded: true,
        sdkInstalled: true,
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        dollarCommandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit: vi.fn(),
        onModeSelect,
        permissionMode: 'build',
      })
    );

    const e = reactKeyEvent({ key: 'Tab', shiftKey: true });
    result.current.onKeyDown(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(getNextPrimaryMode).toHaveBeenCalledWith('build');
    expect(onModeSelect).toHaveBeenCalledWith('plan');
  });

  it('resets submit refs on key up', () => {
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: true };
    const completionSelectedRef = { current: false };

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        daemonStatusLoaded: true,
        sdkInstalled: true,
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        dollarCommandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const e = reactKeyEvent({ key: 'Enter' });
    result.current.onKeyUp(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(submittedOnEnterRef.current).toBe(false);
  });
});
