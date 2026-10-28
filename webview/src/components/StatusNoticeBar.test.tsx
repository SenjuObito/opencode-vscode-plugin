import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StatusNoticeBar, {
  __resetNoticeStateForTest,
  getRetryStatus,
  onRetryStatusFromHost,
  setRetryStatus,
} from './StatusNoticeBar';
import type { ClaudeMessage } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

const messagesState = { loading: false, streamingActive: false, sessionLoading: false };
vi.mock('../contexts/MessagesContext', () => ({
  useMessages: () => messagesState,
}));

const sessionState = { currentSessionId: 'ses_a' as string | null };
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => sessionState,
}));

const sendToJava = vi.fn();
vi.mock('../utils/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJava(...args),
}));

const retryPayload = (overrides: Record<string, unknown> = {}) => ({
  sessionID: 'ses_a',
  type: 'retry',
  message: 'Free usage exceeded, subscribe to Go',
  attempt: 3,
  next: null,
  action: {
    reason: 'free_tier_limit',
    title: 'Free limit reached',
    label: 'subscribe',
    link: 'https://opencode.ai/go',
  },
  ...overrides,
});

const QUOTA_TEXT = 'OpenCode 请求等待超时 (180s)。服务端返回：Free usage exceeded, subscribe to Go';

const quotaMessage = (overrides: Partial<ClaudeMessage> = {}): ClaudeMessage => ({
  type: 'error',
  content: QUOTA_TEXT,
  timestamp: String(Date.now()),
  ...overrides,
});

const getMessageText = (message: ClaudeMessage): string => message.content ?? '';

const renderBar = (messages: ClaudeMessage[]) =>
  render(<StatusNoticeBar messages={messages} getMessageText={getMessageText} />);

describe('StatusNoticeBar — retry notice (regression)', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    __resetNoticeStateForTest();
    messagesState.loading = true;
    messagesState.streamingActive = false;
    messagesState.sessionLoading = false;
    sessionState.currentSessionId = 'ses_a';
  });

  afterEach(() => {
    cleanup();
    __resetNoticeStateForTest();
  });

  it('shows the server reason while the turn is running', () => {
    setRetryStatus(retryPayload());

    const { container } = renderBar([]);

    expect(container.querySelector('.status-notice-bar--warning')).toBeTruthy();
    expect(screen.getByText('Free usage exceeded, subscribe to Go')).toBeTruthy();
    // The action title wins over the generic fallback label.
    expect(screen.getByText('Free limit reached')).toBeTruthy();
  });

  it('opens the action link through the host', () => {
    setRetryStatus(retryPayload());

    renderBar([]);
    fireEvent.click(screen.getByText('subscribe'));

    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://opencode.ai/go');
  });

  it('stays hidden once the turn settles', () => {
    setRetryStatus(retryPayload());
    messagesState.loading = false;
    messagesState.streamingActive = false;

    const { container } = renderBar([]);

    expect(container.querySelector('.status-notice-bar')).toBeNull();
  });

  it('does not leak a notice from another session', () => {
    setRetryStatus(retryPayload({ sessionID: 'ses_other' }));

    const { container } = renderBar([]);

    expect(container.querySelector('.status-notice-bar')).toBeNull();
  });

  it('drops the buffered notice when dismissed', () => {
    setRetryStatus(retryPayload());

    const { container } = renderBar([]);
    fireEvent.click(container.querySelector('.status-notice-dismiss') as HTMLElement);

    expect(getRetryStatus()).toBeNull();
  });
});

describe('onRetryStatusFromHost', () => {
  beforeEach(() => __resetNoticeStateForTest());

  it('accepts the two-argument (sessionId, json) form', () => {
    onRetryStatusFromHost('ses_a', JSON.stringify(retryPayload()));

    expect(getRetryStatus()?.message).toBe('Free usage exceeded, subscribe to Go');
  });

  it('accepts the single-argument json form', () => {
    onRetryStatusFromHost(JSON.stringify(retryPayload({ message: 'Rate limit exceeded' })));

    expect(getRetryStatus()?.message).toBe('Rate limit exceeded');
  });

  it('clears on an empty payload', () => {
    setRetryStatus(retryPayload());

    onRetryStatusFromHost('ses_a', '');

    expect(getRetryStatus()).toBeNull();
  });

  it('clears rather than rendering malformed json', () => {
    setRetryStatus(retryPayload());

    onRetryStatusFromHost('ses_a', 'not-json');

    expect(getRetryStatus()).toBeNull();
  });
});

describe('StatusNoticeBar — terminal quota notice', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    __resetNoticeStateForTest();
    messagesState.loading = false;
    messagesState.streamingActive = false;
    messagesState.sessionLoading = false;
    sessionState.currentSessionId = 'ses_a';
  });

  afterEach(() => {
    cleanup();
    __resetNoticeStateForTest();
  });

  it('renders the error variant with title and body copy', () => {
    const { container } = renderBar([quotaMessage()]);

    expect(container.querySelector('.status-notice-bar--error')).toBeTruthy();
    expect(screen.getByText('errorDiagnostic.opencodeQuotaExceeded.title')).toBeTruthy();
    expect(screen.getByText('errorDiagnostic.opencodeQuotaExceeded.notice')).toBeTruthy();
    // No inline diagnostic card, no retry chrome.
    expect(container.querySelector('.status-notice-bar--warning')).toBeNull();
  });

  it('stays put across repeated full-snapshot rebuilds', () => {
    const message = quotaMessage();
    const { container, rerender } = renderBar([message]);

    // A snapshot replay hands over fresh message objects with identical data.
    rerender(<StatusNoticeBar messages={[{ ...message }]} getMessageText={getMessageText} />);
    rerender(<StatusNoticeBar messages={[{ ...message }, { ...message }]} getMessageText={getMessageText} />);

    expect(container.querySelector('.status-notice-bar--error')).toBeTruthy();
  });

  it('disappears when dismissed', () => {
    const { container } = renderBar([quotaMessage()]);

    fireEvent.click(container.querySelector('.status-notice-dismiss') as HTMLElement);

    expect(container.querySelector('.status-notice-bar--error')).toBeNull();
  });

  it('remembers the dismissal across a remount (tab switch back)', () => {
    const message = quotaMessage();
    const { container, unmount } = renderBar([message]);
    fireEvent.click(container.querySelector('.status-notice-dismiss') as HTMLElement);
    unmount();

    const second = renderBar([{ ...message }]);

    expect(second.container.querySelector('.status-notice-bar--error')).toBeNull();
  });

  it('shows again for a new error with a different timestamp', () => {
    const { container } = renderBar([quotaMessage({ timestamp: '1000' })]);
    fireEvent.click(container.querySelector('.status-notice-dismiss') as HTMLElement);
    expect(container.querySelector('.status-notice-bar--error')).toBeNull();

    const { container: next } = renderBar([
      quotaMessage({ timestamp: '1000' }),
      quotaMessage({ timestamp: '2000' }),
    ]);

    expect(next.querySelector('.status-notice-bar--error')).toBeTruthy();
  });

  it('retires the notice when a new turn starts', () => {
    // One stable snapshot: the notice key is derived from the message, so the
    // rerenders must hand over the *same* message (as a snapshot replay does).
    const message = quotaMessage();
    const { container, rerender } = renderBar([message]);
    expect(container.querySelector('.status-notice-bar--error')).toBeTruthy();

    messagesState.loading = true;
    rerender(<StatusNoticeBar messages={[message]} getMessageText={getMessageText} />);
    expect(container.querySelector('.status-notice-bar--error')).toBeNull();

    // ...and it must not come back once that turn settles.
    messagesState.loading = false;
    rerender(<StatusNoticeBar messages={[message]} getMessageText={getMessageText} />);
    expect(container.querySelector('.status-notice-bar--error')).toBeNull();
  });

  it('lets the retry notice win while a turn is running', () => {
    messagesState.loading = true;
    setRetryStatus(retryPayload());

    const { container } = renderBar([quotaMessage()]);

    expect(container.querySelector('.status-notice-bar--warning')).toBeTruthy();
    expect(container.querySelector('.status-notice-bar--error')).toBeNull();
  });

  it('ignores card-type patterns', () => {
    const { container } = renderBar([
      quotaMessage({ content: 'Error: spawn EBUSY' }),
    ]);

    expect(container.querySelector('.status-notice-bar')).toBeNull();
  });

  it('ignores provider-not-configured errors', () => {
    const { container } = renderBar([
      quotaMessage({ content: 'API Key not configured and no CLI session found' }),
    ]);

    expect(container.querySelector('.status-notice-bar')).toBeNull();
  });

  it('keeps notice state per session', () => {
    const message = quotaMessage();
    const { container, rerender } = renderBar([message]);
    fireEvent.click(container.querySelector('.status-notice-dismiss') as HTMLElement);
    expect(container.querySelector('.status-notice-bar--error')).toBeNull();

    sessionState.currentSessionId = 'ses_b';
    rerender(<StatusNoticeBar messages={[message]} getMessageText={getMessageText} />);

    expect(container.querySelector('.status-notice-bar--error')).toBeTruthy();
  });

  it('stays hidden while a session is being restored', () => {
    messagesState.sessionLoading = true;

    const { container } = renderBar([quotaMessage()]);

    expect(container.querySelector('.status-notice-bar')).toBeNull();
  });
});

describe('StatusNoticeBar — upgrade action', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    __resetNoticeStateForTest();
    messagesState.loading = false;
    messagesState.streamingActive = false;
    messagesState.sessionLoading = false;
    sessionState.currentSessionId = 'ses_a';
  });

  afterEach(() => {
    cleanup();
    __resetNoticeStateForTest();
  });

  it('uses the link pushed by the server during the turn', () => {
    setRetryStatus(retryPayload({ action: { label: 'subscribe', link: 'https://server/pay' } }));

    const { container } = renderBar([quotaMessage()]);
    const action = container.querySelector('.status-notice-action') as HTMLElement;

    expect(action.textContent).toBe('errorDiagnostic.opencodeQuotaExceeded.upgrade');
    fireEvent.click(action);
    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://server/pay');
  });

  it('keeps the link after the turn-settle clear wipes the retry payload', () => {
    setRetryStatus(retryPayload({ action: { label: 'subscribe', link: 'https://server/pay' } }));
    const message = quotaMessage();
    const { container, rerender } = renderBar([message]);

    // RetryStatusBar clears the buffered payload the moment the turn settles —
    // which is exactly when the quota error appears.
    act(() => {
      setRetryStatus(null);
    });
    rerender(<StatusNoticeBar messages={[message]} getMessageText={getMessageText} />);

    const action = container.querySelector('.status-notice-action') as HTMLElement;
    expect(action).toBeTruthy();
    fireEvent.click(action);
    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://server/pay');
  });

  it('falls back to the pattern link when the server pushed none', () => {
    const { container } = renderBar([quotaMessage()]);
    const action = container.querySelector('.status-notice-action') as HTMLElement;

    fireEvent.click(action);

    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://opencode.ai/go');
  });

  it('does not carry a link captured in a previous turn', () => {
    messagesState.loading = true;
    setRetryStatus(retryPayload({ action: { label: 'subscribe', link: 'https://turn-a' } }));

    const { container, rerender } = renderBar([]);
    expect(container.querySelector('.status-notice-bar--warning')).toBeTruthy();

    // Turn settles, then a brand-new turn starts: the captured action is dropped.
    messagesState.loading = false;
    rerender(<StatusNoticeBar messages={[]} getMessageText={getMessageText} />);
    messagesState.loading = true;
    rerender(<StatusNoticeBar messages={[]} getMessageText={getMessageText} />);

    // That new turn fails on quota, with no retry status of its own.
    messagesState.loading = false;
    rerender(<StatusNoticeBar messages={[quotaMessage()]} getMessageText={getMessageText} />);

    const action = container.querySelector('.status-notice-action') as HTMLElement;
    fireEvent.click(action);

    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://opencode.ai/go');
  });

  it('does not carry a link captured in another session', () => {
    setRetryStatus(retryPayload({ sessionID: 'ses_other', action: { label: 'subscribe', link: 'https://turn-a' } }));

    const { container } = renderBar([quotaMessage()]);
    const action = container.querySelector('.status-notice-action') as HTMLElement;

    fireEvent.click(action);

    expect(sendToJava).toHaveBeenCalledWith('open_external_url', 'https://opencode.ai/go');
  });
});
