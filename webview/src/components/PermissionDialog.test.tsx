import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import PermissionDialog from './PermissionDialog';
import type { PermissionRequest } from './PermissionDialog';

const countdown = vi.hoisted(() => ({
  state: { remainingSeconds: 100, isTimeWarning: false },
  markSubmitted: vi.fn(() => true),
  lastOpts: null as null | { onTimeout?: () => void; requestKey?: string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

vi.mock('./MarkdownBlock', () => ({
  default: function MarkdownBlockMock({ content }: { content: string }) {
    return null;
  },
}));

vi.mock('../hooks/useDialogCountdownTimeout', () => ({
  useDialogCountdownTimeout: (opts: { onTimeout?: () => void; requestKey?: string }) => {
    countdown.lastOpts = opts;
    return {
      remainingSeconds: countdown.state.remainingSeconds,
      isTimeWarning: countdown.state.isTimeWarning,
      markSubmitted: countdown.markSubmitted,
    };
  },
}));

const setDialogHeightMock = vi.fn();
vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: setDialogHeightMock,
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('../hooks/useInputAreaBottomOffset', () => ({
  useInputAreaBottomOffset: () => 0,
}));

const mkRequest = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  channelId: 'chan-1',
  toolName: 'Bash',
  inputs: { attr: { command: 'ls -la', cwd: '/tmp', description: 'list files' } },
  ...overrides,
});

const renderDialog = (request: PermissionRequest | null, onApproveAlways?: (id: string) => void) => {
  const onApprove = vi.fn();
  const onSkip = vi.fn();
  const approveAlways = onApproveAlways ?? vi.fn();
  const result = render(
    <PermissionDialog
      isOpen
      request={request}
      onApprove={onApprove}
      onSkip={onSkip}
      onApproveAlways={approveAlways}
    />,
  );
  return { onApprove, onSkip, approveAlways, ...result };
};

describe('PermissionDialog', () => {
  beforeEach(() => {
    countdown.state = { remainingSeconds: 100, isTimeWarning: false };
    countdown.markSubmitted.mockClear();
    countdown.lastOpts = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when closed or no request', () => {
    const { container } = render(
      <PermissionDialog isOpen={false} request={mkRequest()} onApprove={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders v3 dialog structure with subtitle', () => {
    renderDialog(mkRequest());
    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();
    expect(document.querySelector('.permission-dialog-v3-options')).toBeTruthy();
    expect(screen.getByText('permission.fromExternalProcess')).toBeTruthy();
  });

  it('approve calls onApprove with the channelId', () => {
    const { onApprove } = renderDialog(mkRequest());
    fireEvent.click(screen.getByText('permission.allow'));
    expect(onApprove).toHaveBeenCalledWith('chan-1');
  });

  it('skip calls onSkip with the channelId', () => {
    const { onSkip } = renderDialog(mkRequest());
    fireEvent.click(screen.getByText('permission.deny'));
    expect(onSkip).toHaveBeenCalledWith('chan-1');
  });

  it('approve always calls onApproveAlways when provided', () => {
    const { approveAlways } = renderDialog(mkRequest());
    fireEvent.click(screen.getByText('permission.allowAlways'));
    expect(approveAlways).toHaveBeenCalledWith('chan-1');
  });

  it('applies warning-mode class to overlay when in the warning window', () => {
    countdown.state = { remainingSeconds: 10, isTimeWarning: true };
    renderDialog(mkRequest());
    expect(document.querySelector('.warning-mode')).toBeTruthy();
  });

  it('timeout invokes onSkip for the active request even when the countdown is gated', () => {
    const { onSkip } = renderDialog(mkRequest());
    countdown.markSubmitted.mockReturnValue(false);
    act(() => {
      countdown.lastOpts?.onTimeout?.();
    });
    expect(countdown.markSubmitted).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith('chan-1');
  });

  it('renders v3 dialog structure', () => {
    renderDialog(mkRequest());
    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();
    expect(document.querySelector('.permission-dialog-v3-options')).toBeTruthy();
  });

  it('can be minimized to a single bar and restored on click', () => {
    renderDialog(mkRequest());
    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();

    const collapseBtn = document.querySelector('.permission-dialog-collapse-btn');
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn!);

    // Should be in minimized mode
    expect(document.querySelector('.permission-dialog-v3')).toBeFalsy();
    expect(document.querySelector('.permission-dialog-minimized')).toBeTruthy();
    expect(document.querySelector('.permission-dialog-overlay.collapsed-mode')).toBeTruthy();

    // Clicking the expand button restores the full dialog
    const expandBtn = document.querySelector('.permission-dialog-expand-btn');
    expect(expandBtn).toBeTruthy();
    fireEvent.click(expandBtn!);

    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();
    expect(document.querySelector('.permission-dialog-minimized')).toBeFalsy();
  });

  it('restores dialog when clicking on the minimized card body', () => {
    renderDialog(mkRequest());
    fireEvent.click(document.querySelector('.permission-dialog-collapse-btn')!);

    const minimizedCard = document.querySelector('.permission-dialog-minimized');
    expect(minimizedCard).toBeTruthy();
    fireEvent.click(minimizedCard!);

    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();
  });

  it('resets minimized state when a new request arrives', () => {
    const { rerender } = render(
      <PermissionDialog
        isOpen
        request={mkRequest({ channelId: 'req-1' })}
        onApprove={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    // Minimize
    fireEvent.click(document.querySelector('.permission-dialog-collapse-btn')!);
    expect(document.querySelector('.permission-dialog-minimized')).toBeTruthy();

    // New request arrives
    rerender(
      <PermissionDialog
        isOpen
        request={mkRequest({ channelId: 'req-2' })}
        onApprove={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    // Automatically expanded
    expect(document.querySelector('.permission-dialog-v3')).toBeTruthy();
    expect(document.querySelector('.permission-dialog-minimized')).toBeFalsy();
  });
});
