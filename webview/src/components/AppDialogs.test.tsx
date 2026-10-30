import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppDialogs } from './AppDialogs';
import type { PermissionRequest } from './PermissionDialog';

/**
 * A prompt belongs to a tab, so it may only float over that tab's chat page.
 * The dialog layer is a projection of the active tab; the view gate is
 * `promptsVisible` (settings / history must never show it).
 */
const permission = vi.hoisted(() => ({
  request: {
    channelId: 'call_1',
    toolName: 'bash',
    inputs: { command: 'ls' },
  } as PermissionRequest,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

vi.mock('./MarkdownBlock', () => ({
  default: function MarkdownBlockMock() {
    return null;
  },
}));

vi.mock('../contexts/DialogContext', () => ({
  useDialogs: () => ({
    planApprovalDialogOpen: false,
    currentPlanApprovalRequest: null,
    handlePlanApprovalApprove: vi.fn(),
    handlePlanApprovalReject: vi.fn(),
    contextUsageDialogOpen: false,
    contextUsageIsLoading: false,
    contextUsageData: null,
    closeContextUsageDialog: vi.fn(),
    permissionDialogOpen: true,
    currentPermissionRequest: permission.request,
    handlePermissionApprove: vi.fn(),
    handlePermissionApproveAlways: vi.fn(),
    handlePermissionSkip: vi.fn(),
    handlePermissionTimeout: vi.fn(),
    askUserQuestionDialogOpen: false,
    currentAskUserQuestionRequest: null,
    handleAskUserQuestionSubmit: vi.fn(),
    handleAskUserQuestionSkip: vi.fn(),
    handleAskUserQuestionTimeout: vi.fn(),
  }),
}));

vi.mock('../contexts/UIStateContext', () => ({
  useUIState: () => ({
    addModelDialogOpen: false,
    setAddModelDialogOpen: vi.fn(),
  }),
}));

const renderDialogs = (promptsVisible: boolean) => render(
  <AppDialogs
    showInterruptConfirm={false}
    onConfirmInterrupt={vi.fn()}
    onCancelInterrupt={vi.fn()}
    promptsVisible={promptsVisible}
  />,
);

describe('AppDialogs prompt visibility', () => {
  it('renders a pending permission prompt while the chat page is shown', () => {
    const { container } = renderDialogs(true);
    expect(container.querySelector('.permission-dialog-overlay')).not.toBeNull();
  });

  it('hides the prompt on settings / history without dropping it', () => {
    const { container } = renderDialogs(false);
    expect(container.querySelector('.permission-dialog-overlay')).toBeNull();
  });
});
