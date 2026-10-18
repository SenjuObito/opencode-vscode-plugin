import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatHeader } from './ChatHeader';
import type { SessionTabData } from './types';

const mockT = ((key: string) => key) as any;

describe('ChatHeader', () => {
  const mockTabs: SessionTabData[] = [
    {
      id: 'tab-1',
      sessionId: 'sess-1',
      title: 'Tab 1',
      messages: [],
      isShared: false,
    },
    {
      id: 'tab-2',
      sessionId: 'sess-2',
      title: 'Tab 2',
      messages: [],
      isShared: true,
    },
  ];

  const defaultProps = {
    currentView: 'chat' as const,
    t: mockT,
    tabs: mockTabs,
    activeTabId: 'tab-1',
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onRenameTab: vi.fn(),
    onForkTab: vi.fn(),
    onShareTab: vi.fn(),
    onCopyShareLinkTab: vi.fn(),
    onUnshareTab: vi.fn(),
    onBack: vi.fn(),
    onNewSession: vi.fn(),
    onHistory: vi.fn(),
    onSettings: vi.fn(),
  };

  it('renders session tabs and triggers onSelectTab when clicked', () => {
    const onSelectTab = vi.fn();
    render(<ChatHeader {...defaultProps} onSelectTab={onSelectTab} />);

    const tab2 = screen.getByText('Tab 2');
    expect(tab2).toBeTruthy();

    fireEvent.click(tab2);
    expect(onSelectTab).toHaveBeenCalledWith('tab-2');
  });

  it('renders new session button and triggers onNewSession when clicked', () => {
    const onNewSession = vi.fn();
    render(<ChatHeader {...defaultProps} onNewSession={onNewSession} />);

    const newSessionBtn = screen.getByLabelText('common.newSession');
    expect(newSessionBtn).toBeTruthy();

    fireEvent.click(newSessionBtn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('renders history button and triggers onHistory when clicked', () => {
    const onHistory = vi.fn();
    render(<ChatHeader {...defaultProps} onHistory={onHistory} />);

    const historyBtn = screen.getByLabelText('common.history');
    expect(historyBtn).toBeTruthy();

    fireEvent.click(historyBtn);
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it('renders settings button and triggers onSettings', () => {
    const onSettings = vi.fn();
    render(<ChatHeader {...defaultProps} onSettings={onSettings} />);

    const settingsBtn = screen.getByLabelText('common.settings');
    expect(settingsBtn).toBeTruthy();

    fireEvent.click(settingsBtn);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('renders back button in history view and triggers onBack', () => {
    const onBack = vi.fn();
    render(<ChatHeader {...defaultProps} currentView="history" onBack={onBack} />);

    const backBtn = screen.getByText('common.back');
    expect(backBtn).toBeTruthy();

    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('triggers onExportTab when clicking export in tab context menu', () => {
    const onExportTab = vi.fn();
    render(<ChatHeader {...defaultProps} onExportTab={onExportTab} />);

    // Right-click on tab
    const tabEl = screen.getByText('Tab 1');
    fireEvent.contextMenu(tabEl);

    // Context menu should appear with export item
    const exportBtn = screen.getByText('chat.exportMarkdown');
    expect(exportBtn).toBeTruthy();

    fireEvent.click(exportBtn);
    expect(onExportTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'tab-1' }));
  });

  it('triggers onReorderTabs on drag (no long-press wait)', () => {
    const onReorderTabs = vi.fn();
    const onSelectTab = vi.fn();
    render(<ChatHeader {...defaultProps} onReorderTabs={onReorderTabs} onSelectTab={onSelectTab} />);

    const tab1 = screen.getByText('Tab 1');
    const tab2 = screen.getByText('Tab 2');

    vi.spyOn(tab1.parentElement!, 'getBoundingClientRect').mockReturnValue({
      left: 10, right: 100, width: 90, top: 0, bottom: 30, height: 30, x: 10, y: 0, toJSON: () => {},
    });
    vi.spyOn(tab2.parentElement!, 'getBoundingClientRect').mockReturnValue({
      left: 110, right: 200, width: 90, top: 0, bottom: 30, height: 30, x: 110, y: 0, toJSON: () => {},
    });

    // Press on Tab 1, drag past Tab 2's center, then release -> reorder 0 -> 1
    fireEvent.mouseDown(tab1.parentElement!, { clientX: 20, clientY: 10, button: 0 });
    fireEvent.mouseMove(document, { clientX: 180, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 180, clientY: 10 });

    expect(onReorderTabs).toHaveBeenCalledWith(0, 1);
    // A real drag suppresses the subsequent click selection
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('selects the tab on short press without reordering', () => {
    const onReorderTabs = vi.fn();
    const onSelectTab = vi.fn();
    render(<ChatHeader {...defaultProps} onReorderTabs={onReorderTabs} onSelectTab={onSelectTab} />);

    const tab2 = screen.getByText('Tab 2');

    // Press and release at the same position (no drag beyond threshold) -> select tab, no reorder
    fireEvent.mouseDown(tab2.parentElement!, { clientX: 150, clientY: 10, button: 0 });
    fireEvent.mouseUp(tab2.parentElement!, { clientX: 150, clientY: 10, button: 0 });
    fireEvent.click(tab2.parentElement!);

    expect(onReorderTabs).not.toHaveBeenCalled();
    expect(onSelectTab).toHaveBeenCalledWith('tab-2');
  });
});
