import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RetryStatusBar, {
  getRetryStatus,
  onRetryStatusFromHost,
  setRetryStatus,
} from './RetryStatusBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

const messagesState = { loading: true, streamingActive: false };
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

describe('RetryStatusBar', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    messagesState.loading = true;
    messagesState.streamingActive = false;
    sessionState.currentSessionId = 'ses_a';
    setRetryStatus(null);
  });

  afterEach(() => {
    cleanup();
    setRetryStatus(null);
  });

  it('shows the server reason while the turn is running', () => {
    setRetryStatus(retryPayload());

    render(<RetryStatusBar />);

    expect(screen.getByText('Free usage exceeded, subscribe to Go')).toBeTruthy();
    // The action title wins over the generic fallback label.
    expect(screen.getByText('Free limit reached')).toBeTruthy();
  });

  it('opens the action link through the host', () => {
    setRetryStatus(retryPayload());

    render(<RetryStatusBar />);
    fireEvent.click(screen.getByText('subscribe'));

    expect(sendToJava).toHaveBeenCalledWith('open_browser', 'https://opencode.ai/go');
  });

  it('stays hidden once the turn settles', () => {
    setRetryStatus(retryPayload());
    messagesState.loading = false;
    messagesState.streamingActive = false;

    const { container } = render(<RetryStatusBar />);

    expect(container.querySelector('.retry-status-bar')).toBeNull();
  });

  it('does not leak a notice from another session', () => {
    setRetryStatus(retryPayload({ sessionID: 'ses_other' }));

    const { container } = render(<RetryStatusBar />);

    expect(container.querySelector('.retry-status-bar')).toBeNull();
  });

  it('drops the buffered notice when dismissed', () => {
    setRetryStatus(retryPayload());

    const { container } = render(<RetryStatusBar />);
    fireEvent.click(container.querySelector('.retry-status-dismiss') as HTMLElement);

    expect(getRetryStatus()).toBeNull();
  });
});

describe('onRetryStatusFromHost', () => {
  beforeEach(() => setRetryStatus(null));

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
