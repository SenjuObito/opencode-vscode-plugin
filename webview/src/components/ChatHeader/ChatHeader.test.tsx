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

  it('triggers batch close actions from tab context menu', () => {
    const onCloseOtherTabs = vi.fn();
    const onCloseTabsToLeft = vi.fn();
    const onCloseTabsToRight = vi.fn();
    const onCloseAllTabs = vi.fn();

    const threeTabs = [
      { id: 'tab-1', title: 'Tab 1', messages: [] },
      { id: 'tab-2', title: 'Tab 2', messages: [] },
      { id: 'tab-3', title: 'Tab 3', messages: [] },
    ];

    render(
      <ChatHeader
        {...defaultProps}
        tabs={threeTabs}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToLeft={onCloseTabsToLeft}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseAllTabs={onCloseAllTabs}
      />
    );

    // Right click on middle tab (Tab 2)
    fireEvent.contextMenu(screen.getByText('Tab 2'));

    // Verify all 4 batch close options are present and enabled
    const closeOthersBtn = screen.getByText('chat.closeOtherTabs').closest('button')!;
    const closeRightBtn = screen.getByText('chat.closeTabsToRight').closest('button')!;
    const closeLeftBtn = screen.getByText('chat.closeTabsToLeft').closest('button')!;
    const closeAllBtn = screen.getByText('chat.closeAllTabs').closest('button')!;

    expect(closeOthersBtn.disabled).toBe(false);
    expect(closeRightBtn.disabled).toBe(false);
    expect(closeLeftBtn.disabled).toBe(false);
    expect(closeAllBtn.disabled).toBe(false);

    fireEvent.click(closeOthersBtn);
    expect(onCloseOtherTabs).toHaveBeenCalledWith('tab-2');

    // Right click again to test close to right
    fireEvent.contextMenu(screen.getByText('Tab 2'));
    fireEvent.click(screen.getByText('chat.closeTabsToRight'));
    expect(onCloseTabsToRight).toHaveBeenCalledWith('tab-2');

    // Right click again to test close to left
    fireEvent.contextMenu(screen.getByText('Tab 2'));
    fireEvent.click(screen.getByText('chat.closeTabsToLeft'));
    expect(onCloseTabsToLeft).toHaveBeenCalledWith('tab-2');

    // Right click again to test close all
    fireEvent.contextMenu(screen.getByText('Tab 2'));
    fireEvent.click(screen.getByText('chat.closeAllTabs'));
    expect(onCloseAllTabs).toHaveBeenCalledTimes(1);
  });

  it('disables close left on first tab and close right on last tab', () => {
    const threeTabs = [
      { id: 'tab-1', title: 'Tab 1', messages: [] },
      { id: 'tab-2', title: 'Tab 2', messages: [] },
      { id: 'tab-3', title: 'Tab 3', messages: [] },
    ];

    const { rerender } = render(
      <ChatHeader {...defaultProps} tabs={threeTabs} />
    );

    // Right click first tab -> close to left is disabled
    fireEvent.contextMenu(screen.getByText('Tab 1'));
    const closeLeftFirst = screen.getByText('chat.closeTabsToLeft').closest('button')!;
    const closeRightFirst = screen.getByText('chat.closeTabsToRight').closest('button')!;
    expect(closeLeftFirst.disabled).toBe(true);
    expect(closeRightFirst.disabled).toBe(false);

    // Close menu by clicking outside
    fireEvent.mouseDown(document.body);

    // Right click last tab -> close to right is disabled
    fireEvent.contextMenu(screen.getByText('Tab 3'));
    const closeLeftLast = screen.getByText('chat.closeTabsToLeft').closest('button')!;
    const closeRightLast = screen.getByText('chat.closeTabsToRight').closest('button')!;
    expect(closeLeftLast.disabled).toBe(false);
    expect(closeRightLast.disabled).toBe(true);
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

  describe('overflow menu', () => {
    const makeTabs = (count: number): SessionTabData[] => Array.from({ length: count }, (_, index) => ({
      id: `tab-${index + 1}`,
      sessionId: `sess-${index + 1}`,
      title: `Tab ${index + 1}`,
      messages: [],
      isShared: false,
    }));

    const wideTabSet = makeTabs(4);

    /**
     * Render the bar inside a 260px container: 4 fallback-width tabs (110px)
     * only fit two of them plus the overflow button, so tabs 3-4 collapse into
     * the "…" menu.
     */
    const renderNarrowBar = (activeTabId = 'tab-1') => {
      const onReorderTabs = vi.fn();
      const props = { ...defaultProps, tabs: wideTabSet, activeTabId, onReorderTabs };
      const view = render(<ChatHeader {...props} />);
      const container = document.querySelector('.session-tabs-container') as HTMLElement;
      Object.defineProperty(container, 'clientWidth', { configurable: true, value: 260 });
      // Re-run the capacity effect now that the container reports a width.
      view.rerender(<ChatHeader {...props} tabs={[...wideTabSet]} />);
      return { onReorderTabs };
    };

    it('keeps a tab dragged out of the collapsed menu in the visible bar', async () => {
      const { onReorderTabs } = renderNarrowBar();

      fireEvent.click(screen.getByRole('button', { name: 'common.moreSessions' }));
      const dragged = screen.getByText('Tab 4');
      const row = dragged.closest('.session-tab-overflow-item');
      expect(row).not.toBeNull();

      // Drop well outside the overflow menu: the bar is the drop target.
      fireEvent.mouseDown(row!, { clientX: 200, clientY: 200, button: 0 });
      fireEvent.mouseMove(document, { clientX: 500, clientY: 300 });
      fireEvent.mouseUp(document, { clientX: 500, clientY: 300 });

      expect(onReorderTabs).toHaveBeenCalledWith(3, 1);

      // The dropped tab must stay rendered in the bar instead of snapping back
      // into the collapsed menu after the width recalculation.
      const moved = screen.getByText('Tab 4');
      expect(moved.closest('.session-tab-item')).not.toBeNull();
      expect(moved.closest('.session-tab-overflow-item')).toBeNull();
    });

    it('keeps the active tab visible without dropping another tab', () => {
      renderNarrowBar('tab-4');

      const visibleTitles = Array.from(document.querySelectorAll('.session-tab-item .session-tab-title'))
        .map((element) => element.textContent);
      expect(visibleTitles).toEqual(['Tab 1', 'Tab 4']);
      // Tab 2 and Tab 3 remain reachable through the overflow menu.
      expect(screen.getByRole('button', { name: 'common.moreSessions' })).toBeTruthy();
    });
  });
});
