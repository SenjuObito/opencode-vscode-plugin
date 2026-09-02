import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
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

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
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
  render(
    <PermissionDialog
      isOpen
      request={request}
      onApprove={onApprove}
      onSkip={onSkip}
      onApproveAlways={approveAlways}
    />,
  );
  return { onApprove, onSkip, approveAlways };
};

describe('PermissionDialog', () => {
  beforeEach(() => {
    countdown.state = { remainingSeconds: 100, isTimeWarning: false };
    countdown.markSubmitted.mockClear();
    countdown.lastOpts = null;
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
});
