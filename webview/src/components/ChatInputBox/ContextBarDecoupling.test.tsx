// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextBar } from './ContextBar';

describe('ContextBar - Decoupled context visibility', () => {
  it('renders placeholder button when autoOpenFileEnabled is false', () => {
    const onRequestEnable = vi.fn();
    render(
      <ContextBar
        autoOpenFileEnabled={false}
        activeFile={undefined}
        onRequestEnableFileContext={onRequestEnable}
      />
    );

    const placeholderBtn = screen.getByRole('button', { name: /fileContext\.placeholder/i });
    expect(placeholderBtn).toBeTruthy();

    fireEvent.click(placeholderBtn);
    const confirmBtn = screen.getByRole('button', { name: /fileContext\.enable/i });
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn);

    expect(onRequestEnable).toHaveBeenCalled();
  });

  it('renders context chip when autoOpenFileEnabled is true and activeFile is provided', () => {
    const onClearFile = vi.fn();
    render(
      <ContextBar
        autoOpenFileEnabled={true}
        activeFile="/path/to/MyService.java"
        selectedLines="L10-20"
        onClearFile={onClearFile}
      />
    );

    expect(screen.getByText('MyService.java#L10-20')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fileContext\.placeholder/i })).toBeNull();

    const closeBtn = screen.getByTitle('Remove file context');
    fireEvent.click(closeBtn);
    expect(onClearFile).toHaveBeenCalled();
  });
});
