import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach } from 'vitest';
import { useDialogManagement } from './useDialogManagement';
import { MessagesProvider } from '../contexts/MessagesContext';
import { SessionProvider, useSession } from '../contexts/SessionContext';
import { getTabStore, resetTabStore } from '../store/tabStore';
import type { SessionTabData } from '../components/ChatHeader/types';

const t = ((key: string) => key) as any;

// useDialogManagement consumes MessagesContext and SessionContext, so every
// render must run inside both providers. createElement keeps this file
// JSX-free (.ts).
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SessionProvider, null, createElement(MessagesProvider, null, children));

// The tab store is a module singleton and is now the single source of truth for
// prompt queues, so every test starts with a fresh window.
beforeEach(() => {
  resetTabStore();
});

const mkTab = (id: string): SessionTabData => ({
  id,
  sessionId: null,
  title: id,
  messages: [],
  pendingPermissions: [],
  pendingQuestions: [],
  pendingPlans: [],
} as SessionTabData);

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

  it('a prompt owned by a background tab waits there and appears when that tab is selected', () => {
    const store = getTabStore();
    store.setTabs([mkTab('tab-a'), mkTab('tab-b')]);
    store.setActiveTabId('tab-a');

    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => {
      result.current.openPermissionDialog({
        channelId: 'P-bg',
        toolName: 'Bash',
        sessionId: 'ses-bg',
        tabId: 'tab-b',
        inputs: {},
      } as any);
    });

    // A background tab's prompt must not steal the foreground.
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(store.findById('tab-b')?.pendingPermissions?.map((r: any) => r.channelId)).toEqual(['P-bg']);

    act(() => { store.setActiveTabId('tab-b'); });

    expect(result.current.permissionDialogOpen).toBe(true);
    expect(result.current.currentPermissionRequest?.channelId).toBe('P-bg');

    // Answering removes it from the owning tab, not from a second copy.
    act(() => { store.setActiveTabId('tab-a'); });
    act(() => { result.current.handlePermissionSkip('P-bg'); });
    expect(store.findById('tab-b')?.pendingPermissions ?? []).toEqual([]);
  });

  it('leaving the chat page needs no snapshot: the queue stays on its tab', () => {
    const store = getTabStore();
    store.setTabs([mkTab('tab-a')]);
    store.setActiveTabId('tab-a');

    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('Q')); });
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(store.findById('tab-a')?.pendingQuestions?.map((r: any) => r.requestId)).toEqual(['Q']);

    // Switching away and back is a projection change only: the request never
    // leaves the tab record.
    act(() => { store.setActiveTabId(''); });
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    act(() => { store.setActiveTabId('tab-a'); });
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('Q');
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

  it('handleAskUserQuestionTimeout rejects question, interrupts session, and closes dialog', () => {
    const sendCalls: string[] = [];
    (window as any).sendToJava = vi.fn((payload: string) => {
      sendCalls.push(payload);
    });

    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => {
      result.current.openAskUserQuestionDialog({
        requestId: 'Q1',
        toolName: 'AskUserQuestion',
        sessionId: 'ses_123',
        questions: [],
      } as any);
    });

    expect(result.current.askUserQuestionDialogOpen).toBe(true);

    act(() => {
      result.current.handleAskUserQuestionTimeout('Q1');
    });

    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('question.reply'))).toBe(true);
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('session.interrupt') && c.includes('ses_123'))).toBe(true);
  });

  it('handleAskUserQuestionSkip rejects question, interrupts session, and closes dialog', () => {
    const sendCalls: string[] = [];
    (window as any).sendToJava = vi.fn((payload: string) => {
      sendCalls.push(payload);
    });

    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => {
      result.current.openAskUserQuestionDialog({
        requestId: 'Q2',
        toolName: 'AskUserQuestion',
        sessionId: 'ses_789',
        questions: [],
      } as any);
    });

    act(() => {
      result.current.handleAskUserQuestionSkip('Q2');
    });

    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('question.reply') && c.includes('"rejected":true'))).toBe(true);
    // 与超时一致：取消也定向中断发起提问的会话，让迟到的 "Step interrupted"
    // 走 wasAborted 抑制，不再留下错误气泡。
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('session.interrupt') && c.includes('ses_789'))).toBe(true);
  });

  it('handlePermissionTimeout rejects permission, interrupts session, and closes dialog', () => {
    const sendCalls: string[] = [];
    (window as any).sendToJava = vi.fn((payload: string) => {
      sendCalls.push(payload);
    });

    const { result } = renderHook(() => useDialogManagement({ t }), { wrapper });

    act(() => {
      result.current.openPermissionDialog({
        channelId: 'P1',
        toolName: 'Bash',
        sessionId: 'ses_456',
        inputs: {},
      } as any);
    });

    expect(result.current.permissionDialogOpen).toBe(true);

    act(() => {
      result.current.handlePermissionTimeout('P1');
    });

    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('permission.reply') && c.includes('"allow":false'))).toBe(true);
    expect(sendCalls.some((c) => c.startsWith('host_command:') && c.includes('session.interrupt') && c.includes('ses_456'))).toBe(true);
  });
});
