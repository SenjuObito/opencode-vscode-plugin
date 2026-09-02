import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { useDialogManagement } from './useDialogManagement';
import { MessagesProvider } from '../contexts/MessagesContext';
import { SessionProvider, useSession } from '../contexts/SessionContext';

const t = ((key: string) => key) as any;

// useDialogManagement consumes MessagesContext and SessionContext, so every
// render must run inside both providers. createElement keeps this file
// JSX-free (.ts).
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SessionProvider, null, createElement(MessagesProvider, null, children));

const mkAsk = (requestId: string) => ({ requestId } as any);
const mkPermission = (channelId: string) => ({ channelId } as any);
const mkPlan = (requestId: string) => ({ requestId } as any);

// Permission / AskUserQuestion now render as top-level popups backed by a
// single-active + pending-queue model. After a decision the request is gone
// (no inline record is kept). forceClose drops pending requests by id.
describe('useDialogManagement - forceClose question/permission requests', () => {
  it('openAskUserQuestionDialog upserts one pending request per requestId', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });
    // Duplicate id is ignored (already pending).
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });

    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');
    expect(result.current.pendingAskUserQuestionRequests.map((r) => r.requestId)).toEqual(['B']);
  });

  it('forceCloseAskUserQuestionDialog(null) closes and clears everything', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    act(() => { result.current.forceCloseAskUserQuestionDialog(null); });

    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
    expect(result.current.pendingAskUserQuestionRequests).toEqual([]);
  });

  it('forceCloseAskUserQuestionDialog(id) only drops the matching pending request', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    act(() => { result.current.forceCloseAskUserQuestionDialog('A'); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
    expect(result.current.pendingAskUserQuestionRequests).toEqual([]);
  });

  it('submit closes the dialog and drops the request (no record kept)', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });
    act(() => { result.current.handleAskUserQuestionSubmit('A', { q: 'answer' }); });

    // The submitted request (A) is gone; B is promoted to current.
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
    expect(result.current.pendingAskUserQuestionRequests).toEqual([]);
  });

  it('skip closes the dialog and drops the request', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });
    act(() => { result.current.handleAskUserQuestionSkip('B'); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');
    expect(result.current.pendingAskUserQuestionRequests).toEqual([]);
  });

  it('openPermissionDialog upserts one pending request per channelId', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    // Duplicate id is ignored.
    act(() => { result.current.openPermissionDialog(mkPermission('A')); });

    expect(result.current.permissionDialogOpen).toBe(true);
    expect(result.current.currentPermissionRequest?.channelId).toBe('A');
    expect(result.current.pendingPermissionRequests.map((r) => r.channelId)).toEqual(['B']);
  });

  it('permission decisions close the dialog and drop the request', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    act(() => { result.current.handlePermissionApprove('A'); });

    expect(result.current.currentPermissionRequest?.channelId).toBe('B');
    expect(result.current.pendingPermissionRequests).toEqual([]);

    act(() => { result.current.handlePermissionApproveAlways('B'); });
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('forceClosePermissionDialog(null) closes and clears everything', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });

    act(() => { result.current.forceClosePermissionDialog(null); });

    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
    expect(result.current.pendingPermissionRequests).toEqual([]);
  });

  it('forceClosePermissionDialog(id) only drops the matching pending request', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });

    act(() => { result.current.forceClosePermissionDialog('A'); });

    expect(result.current.currentPermissionRequest?.channelId).toBe('B');
    expect(result.current.pendingPermissionRequests).toEqual([]);
  });

  it('invalidateQuestionCard / invalidatePermissionCard force-close by id', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('P')); });

    act(() => { result.current.invalidateQuestionCard('A'); });
    act(() => { result.current.invalidatePermissionCard('P'); });

    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.permissionDialogOpen).toBe(false);
  });

  it('switching session clears every pending request', () => {
    const { result } = renderHook(
      () => ({ dialogs: useDialogManagement({ t }), session: useSession() }),
      { wrapper },
    );

    act(() => { result.current.dialogs.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.dialogs.openAskUserQuestionDialog(mkAsk('Q')); });

    act(() => { result.current.session.setCurrentSessionId('s1'); });

    expect(result.current.dialogs.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.dialogs.permissionDialogOpen).toBe(false);
    expect(result.current.dialogs.pendingAskUserQuestionRequests).toEqual([]);
    expect(result.current.dialogs.pendingPermissionRequests).toEqual([]);
  });

  it('does not clear requests when currentSessionId is unchanged', () => {
    const { result } = renderHook(
      () => ({ dialogs: useDialogManagement({ t }), session: useSession() }),
      { wrapper },
    );

    act(() => { result.current.dialogs.openAskUserQuestionDialog(mkAsk('Q')); });

    act(() => { result.current.session.setCurrentSessionId(null); });

    expect(result.current.dialogs.currentAskUserQuestionRequest?.requestId).toBe('Q');
  });

  it('forceClosePlanApprovalDialog(null) drains the whole plan-approval queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openPlanApprovalDialog(mkPlan('A')); });
    act(() => { result.current.openPlanApprovalDialog(mkPlan('B')); });
    expect(result.current.planApprovalDialogOpen).toBe(true);

    act(() => { result.current.forceClosePlanApprovalDialog(null); });

    expect(result.current.planApprovalDialogOpen).toBe(false);
    expect(result.current.currentPlanApprovalRequest).toBeNull();
  });
});
