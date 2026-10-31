import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionTabBar } from './SessionTabBar';
import type { SessionTabData } from './types';

const mockT = ((key: string) => key) as any;

const tabs: SessionTabData[] = [
  { id: 'tab-1', sessionId: 'sess-1', title: 'Tab 1', messages: [], isShared: false },
  { id: 'tab-2', sessionId: 'sess-2', title: 'Tab 2', messages: [], isShared: false },
];

function renderBar() {
  const props = {
    tabs,
    activeTabId: 'tab-1',
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onRenameTab: vi.fn(),
    onForkTab: vi.fn(),
    onExportTab: vi.fn(),
    onShareTab: vi.fn(),
    onCopyShareLinkTab: vi.fn(),
    onUnshareTab: vi.fn(),
    t: mockT,
  };
  const utils = render(<SessionTabBar {...props} />);
  return { ...utils, props };
}

function startEditing(tabTitle: string): HTMLInputElement {
  fireEvent.doubleClick(screen.getByText(tabTitle));
  const input = document.querySelector('.session-tab-inline-input') as HTMLInputElement | null;
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

describe('SessionTabBar inline rename', () => {
  it('lets the rename input keep spaces, Backspace and arrows for itself', () => {
    const { props } = renderBar();
    const input = startEditing('Tab 1');

    fireEvent.change(input, { target: { value: 'My New   Title' } });
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });

    // None of those keys may select or close the tab while renaming.
    expect(props.onSelectTab).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();
    expect(input.value).toBe('My New   Title');

    fireEvent.blur(input);
    expect(props.onRenameTab).toHaveBeenCalledWith('tab-1', 'My New   Title');
  });

  it('commits on Enter', () => {
    const { props } = renderBar();
    const input = startEditing('Tab 1');

    fireEvent.change(input, { target: { value: 'Renamed Tab' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(props.onRenameTab).toHaveBeenCalledWith('tab-1', 'Renamed Tab');
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it('keeps the tab keyboard shortcuts while not editing', () => {
    const { props } = renderBar();
    const tab = document.querySelector('[data-tab-id="tab-2"]') as HTMLElement;

    fireEvent.keyDown(tab, { key: ' ' });
    expect(props.onSelectTab).toHaveBeenCalledWith('tab-2');

    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(props.onCloseTab).toHaveBeenCalledWith('tab-2');
  });
});
