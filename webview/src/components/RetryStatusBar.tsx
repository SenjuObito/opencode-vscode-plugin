/**
 * RetryStatusBar
 *
 * Explains why a turn is still "loading": opencode reports rate-limit / quota
 * backoff through `session.status` with `type=retry`, carrying a human-readable
 * `message` plus an optional `action` ({ reason, title, message, label, link }).
 * The daemon forwards that as a `[STATUS]` marker and the host calls
 * `window.updateRetryStatus(json)` (single-arg: this build is single-window).
 *
 * Before this existed the signal never reached the UI at all, so the only thing
 * a user could see was the generic local 180s timeout minutes later — which
 * never named the actual cause (exhausted free tier / quota).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessages } from '../contexts/MessagesContext';
import { useSession } from '../contexts/SessionContext';
import { sendToJava } from '../utils/bridge';
import './RetryStatusBar.less';

/** Server-provided call to action (e.g. subscribe to opencode Go). */
export interface RetryAction {
  reason?: string | null;
  provider?: string | null;
  title?: string | null;
  message?: string | null;
  label?: string | null;
  link?: string | null;
}

/** Payload emitted by the daemon for `session.status` with `type=retry`. */
export interface RetryStatusPayload {
  sessionID?: string;
  type?: string;
  message?: string;
  attempt?: number | null;
  /** Epoch ms of the next attempt, when the server knows it. */
  next?: number | null;
  action?: RetryAction | null;
}

/**
 * Latest payload, kept module-side: the host may call `updateRetryStatus`
 * before this component mounts (or while another view is rendered), and the bar
 * must still hydrate with the retry already in flight.
 */
let latestRetryStatus: RetryStatusPayload | null = null;
const retryStatusListeners = new Set<(payload: RetryStatusPayload | null) => void>();

export const setRetryStatus = (payload: RetryStatusPayload | null): void => {
  latestRetryStatus = payload;
  retryStatusListeners.forEach((listener) => listener(payload));
};

export const getRetryStatus = (): RetryStatusPayload | null => latestRetryStatus;

/**
 * Bridge entry point. The host always passes (sessionId?, json); the single
 * argument form is accepted so a payload-only call still works.
 */
export const onRetryStatusFromHost = (arg0?: string, arg1?: string): void => {
  const raw = typeof arg1 !== 'undefined' ? arg1 : arg0;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    setRetryStatus(null);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as RetryStatusPayload;
    setRetryStatus(parsed && typeof parsed === 'object' ? parsed : null);
  } catch {
    // Malformed payload: hide the bar rather than render raw JSON in the UI.
    setRetryStatus(null);
  }
};

const formatSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

export const RetryStatusBar = () => {
  const { t } = useTranslation();
  const { loading, streamingActive } = useMessages();
  const { currentSessionId } = useSession();
  const [payload, setPayload] = useState<RetryStatusPayload | null>(getRetryStatus);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const listener = (next: RetryStatusPayload | null) => setPayload(next);
    retryStatusListeners.add(listener);
    return () => {
      retryStatusListeners.delete(listener);
    };
  }, []);

  const turnActive = loading || streamingActive;

  // Drop the buffered notice once the turn settles, so a later turn cannot
  // resurrect a stale "retrying…" bar. The host only emits retry status while a
  // turn is live, so this cannot race a fresh payload.
  useEffect(() => {
    if (!turnActive) {
      setRetryStatus(null);
    }
  }, [turnActive]);

  const retryAt = payload?.next ?? null;
  const hasCountdown = retryAt !== null && retryAt > 0;

  // Tick only while a countdown is on screen, so an idle tab pays nothing.
  useEffect(() => {
    if (!hasCountdown) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCountdown, retryAt]);

  const handleOpenLink = useCallback((link: string) => {
    // The webview traps window.open / external <a>, so route through the host.
    sendToJava('open_browser', link);
  }, []);

  const handleDismiss = useCallback(() => setRetryStatus(null), []);

  // A retry notice only means something while the turn is running.
  if (!payload || !turnActive) {
    return null;
  }

  // A notice from another session must not bleed into the active transcript.
  if (payload.sessionID && currentSessionId && payload.sessionID !== currentSessionId) {
    return null;
  }

  const message = payload.message?.trim();
  const action = payload.action ?? null;
  const link = action?.link?.trim();
  const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;

  return (
    <div className="retry-status-bar" role="status">
      <span className="codicon codicon-sync retry-status-icon" />
      <div className="retry-status-body">
        <span className="retry-status-title">{action?.title?.trim() || t('retryStatus.title')}</span>
        {message && <span className="retry-status-message">{message}</span>}
        <span className="retry-status-meta">
          {attempt !== null && <span>{t('retryStatus.attempt', { n: attempt })}</span>}
          {hasCountdown && (
            <span>{t('retryStatus.retryIn', { seconds: formatSeconds(retryAt - now) })}</span>
          )}
        </span>
      </div>
      {link && (
        <button
          type="button"
          className="retry-status-action"
          onClick={() => handleOpenLink(link)}
        >
          {action?.label?.trim() || t('retryStatus.openLink')}
        </button>
      )}
      <button
        type="button"
        className="retry-status-dismiss"
        aria-label={t('retryStatus.dismiss')}
        title={t('retryStatus.dismiss')}
        onClick={handleDismiss}
      >
        <span className="codicon codicon-close" />
      </button>
    </div>
  );
};

export default RetryStatusBar;
