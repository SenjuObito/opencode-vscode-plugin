/**
 * StatusNoticeBar
 *
 * Single slot just above the status panel + composer, carrying one of two
 * mutually exclusive notices:
 *
 * 1. **Retry** (`--warning`, spinning icon) — explains why a running turn is
 *    still "loading". opencode reports rate-limit / quota backoff through
 *    `session.status` with `type=retry`, carrying a human-readable `message`
 *    plus an optional `action` ({ reason, title, message, label, link }). The
 *    daemon forwards that as a `[STATUS]` marker and the host calls
 *    `window.updateRetryStatus(sessionId, json)`. Before this existed the signal
 *    never reached the UI at all, so the only thing a user could see was the
 *    generic local timeout minutes later — which never named the actual
 *    cause (exhausted free tier / quota). Visible only while the turn is live.
 *
 * 2. **Terminal notice** (`--error`, static icon) — a persistent, dismissible
 *    bar for errors whose pattern declares `presentation: "bar"`
 *    (see `data/errorPatterns.json`), e.g. quota exhausted. Those errors are
 *    *not* rendered as an inline `ErrorDiagnosticCard`; the actionable part
 *    (switch model / upgrade) belongs next to the composer, where it stays
 *    visible until the user acknowledges it.
 *
 * The two never overlap in time: the retry bar covers the turn while it runs,
 * the terminal bar appears once the turn has settled.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessages } from '../contexts/MessagesContext';
import { useSession } from '../contexts/SessionContext';
import { matchErrorPattern, type DiagnosticPattern } from '../utils/errorMatcher';
import type { ClaudeMessage } from '../types';
import { sendToJava } from '../utils/bridge';
import './StatusNoticeBar.less';

const useMessagesSafe = () => {
  try {
    return useMessages();
  } catch {
    return {
      messages: [],
      loading: false,
      streamingActive: false,
      sessionLoading: false,
    } as unknown as ReturnType<typeof useMessages>;
  }
};

const useSessionSafe = () => {
  try {
    return useSession();
  } catch {
    return {
      currentSessionId: null,
    } as unknown as ReturnType<typeof useSession>;
  }
};

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

/** A call to action resolved for one specific notice. */
interface NoticeAction {
  link: string;
  /** i18n-independent label from the server, used as a tooltip only. */
  serverLabel?: string | null;
  serverTitle?: string | null;
  serverMessage?: string | null;
}

/**
 * Latest payload, kept module-side: the host may call `updateRetryStatus`
 * before this component mounts (or while another view is rendered), and the bar
 * must still hydrate with the retry already in flight.
 */
let latestRetryStatus: RetryStatusPayload | null = null;
const retryStatusListeners = new Set<(payload: RetryStatusPayload | null) => void>();

/**
 * Notices already acknowledged by the user, keyed by
 * {@link noticeKeyFor}. Module-side (not component state) on purpose: the
 * message list is rebuilt from full snapshots and switching tabs remounts the
 * whole tree, so component state would resurrect a dismissed notice.
 */
const dismissedNoticeKeys = new Set<string>();

/**
 * The most recent call to action pushed by the server during a turn
 * (`session.status` → `action.link`). Held separately from
 * {@link latestRetryStatus} because that one is cleared the moment the turn
 * settles — which is exactly when a quota error surfaces.
 */
let pendingRetryAction: (NoticeAction & { sessionID?: string }) | null = null;

/**
 * Per-notice pinned action. Pinning (rather than reading `pendingRetryAction`
 * at render time) prevents a link captured during one turn from leaking into a
 * later notice.
 */
const noticeActionLinks = new Map<string, NoticeAction>();

/** FNV-1a, 32-bit. Only used to keep notice keys short. */
const hashText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Identity of a notice: session + message timestamp + text digest.
 *
 * The timestamp is what makes this stable across snapshot rebuilds (the host
 * assigns it once, when the message is created) while still distinguishing two
 * identical errors raised a minute apart.
 */
export const noticeKeyFor = (
  sessionId: string | null,
  message: ClaudeMessage,
  text: string,
): string => `${sessionId ?? ''}::${Number(message.timestamp) || 0}::${hashText(text.slice(0, 200))}`;

export const setRetryStatus = (payload: RetryStatusPayload | null): void => {
  latestRetryStatus = payload;

  // Capture the call to action before the turn settles, so the terminal notice
  // raised by this turn can offer the server-provided link and message.
  if (payload) {
    const link = payload.action?.link?.trim();
    if (link || payload.action?.title || payload.action?.message || payload.message) {
      pendingRetryAction = {
        link: link || '',
        sessionID: payload.sessionID,
        serverLabel: payload.action?.label ?? null,
        serverTitle: payload.action?.title ?? null,
        serverMessage: payload.action?.message ?? payload.message ?? null,
      };
    }
  }

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

/** Test-only: reset the module-level caches between cases. */
export const __resetNoticeStateForTest = (): void => {
  latestRetryStatus = null;
  pendingRetryAction = null;
  dismissedNoticeKeys.clear();
  noticeActionLinks.clear();
};

const formatSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

/** A terminal notice derived from the last `bar`-type error in the transcript. */
interface TerminalNotice {
  key: string;
  pattern: DiagnosticPattern;
  serverText: string;
}

export interface StatusNoticeBarProps {
  messages?: ClaudeMessage[];
  getMessageText?: (message: ClaudeMessage) => string;
}

const defaultGetMessageText = (message: ClaudeMessage): string => {
  if (typeof message.content === 'string') return message.content;
  const raw = message.content as unknown;
  if (Array.isArray(raw)) {
    return raw
      .map((c: unknown) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? ''))
      .join('');
  }
  return '';
};

interface NoticeBarProps {
  variant: 'warning' | 'error';
  icon: string;
  title: string;
  message?: string;
  meta?: ReactNode;
  action: { label: string; tooltip?: string; onClick: () => void } | null;
  onDismiss: () => void;
  dismissLabel: string;
}

const NoticeBar = ({
  variant,
  icon,
  title,
  message,
  meta,
  action,
  onDismiss,
  dismissLabel,
}: NoticeBarProps) => (
  <div
    className={`status-notice-bar status-notice-bar--${variant}`}
    role={variant === 'error' ? 'alert' : 'status'}
    aria-live={variant === 'error' ? 'polite' : undefined}
  >
    <span className={`codicon ${icon} status-notice-icon`} />
    <div className="status-notice-body">
      <span className="status-notice-title">{title}</span>
      {message && <span className="status-notice-message">{message}</span>}
      {meta && <span className="status-notice-meta">{meta}</span>}
    </div>
    {action && (
      <button
        type="button"
        className="status-notice-action"
        title={action.tooltip}
        onClick={action.onClick}
      >
        {action.label}
      </button>
    )}
    <button
      type="button"
      className="status-notice-dismiss"
      aria-label={dismissLabel}
      title={dismissLabel}
      onClick={onDismiss}
    >
      <span className="codicon codicon-close" />
    </button>
  </div>
);

export const StatusNoticeBar = ({
  messages: propMessages,
  getMessageText: propGetMessageText,
}: StatusNoticeBarProps = {}) => {
  const { t } = useTranslation();
  const messagesCtx = useMessagesSafe();
  const sessionCtx = useSessionSafe();

  const messages = propMessages ?? messagesCtx?.messages ?? [];
  const getMessageText = propGetMessageText ?? defaultGetMessageText;
  const loading = messagesCtx?.loading ?? false;
  const streamingActive = messagesCtx?.streamingActive ?? false;
  const sessionLoading = messagesCtx?.sessionLoading ?? false;
  const currentSessionId = sessionCtx?.currentSessionId ?? null;

  const [payload, setPayload] = useState<RetryStatusPayload | null>(getRetryStatus);
  const [now, setNow] = useState(() => Date.now());
  // The dismissed set lives module-side and is not reactive; bumping this
  // counter is what makes a dismissal re-evaluate the notice.
  const [dismissVersion, setDismissVersion] = useState(0);

  const turnActive = loading || streamingActive;

  const terminalNotice = useMemo<TerminalNotice | null>(() => {
    // A notice raised by a transcript that is still being restored is not
    // something the user can act on yet.
    if (sessionLoading) return null;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== 'error') continue;

      const text = getMessageText(message) ?? '';
      const pattern = matchErrorPattern(text);
      // `card` patterns keep their inline diagnostic card; only `bar` patterns
      // are promoted here.
      if (!pattern || pattern.presentation !== 'bar') continue;

      const key = noticeKeyFor(currentSessionId, message, text);
      // Only the last such error is ever shown: if it was dismissed, the notice
      // is gone — older ones must not resurface in its place.
      if (dismissedNoticeKeys.has(key)) return null;

      return { key, pattern, serverText: text };
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissVersion is a re-evaluation trigger, not an input
  }, [messages, getMessageText, sessionLoading, currentSessionId, dismissVersion]);

  useEffect(() => {
    const listener = (next: RetryStatusPayload | null) => setPayload(next);
    retryStatusListeners.add(listener);
    return () => {
      retryStatusListeners.delete(listener);
    };
  }, []);

  // Drop the buffered notice once the turn settles, so a later turn cannot
  // resurrect a stale "retrying…" bar. The host only emits retry status while a
  // turn is live, so this cannot race a fresh payload.
  useEffect(() => {
    if (!turnActive) {
      setRetryStatus(null);
    }
  }, [turnActive]);

  // A new turn clears the unpinned candidate action so it is not carried
  // into this turn. The terminal notice itself stays visible until the user
  // explicitly dismisses it with the close button.
  const previousTurnActiveRef = useRef(turnActive);
  useEffect(() => {
    const wasActive = previousTurnActiveRef.current;
    previousTurnActiveRef.current = turnActive;
    if (wasActive || !turnActive) return;

    pendingRetryAction = null;
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

  const handleDismissRetry = useCallback(() => setRetryStatus(null), []);

  const terminalNoticeKey = terminalNotice?.key ?? null;
  const handleDismissTerminal = useCallback(() => {
    if (!terminalNoticeKey) return;
    dismissedNoticeKeys.add(terminalNoticeKey);
    noticeActionLinks.delete(terminalNoticeKey);
    setDismissVersion((version) => version + 1);
  }, [terminalNoticeKey]);

  // Resolve (and pin) the call to action for the terminal notice.
  // Order: server-pushed action > pattern fallback > no button at all.
  const terminalAction = ((): NoticeAction | null => {
    if (!terminalNotice) return null;

    const pinned = noticeActionLinks.get(terminalNotice.key);
    if (pinned) return pinned;

    const candidate = pendingRetryAction;
    if (candidate && (!candidate.sessionID || candidate.sessionID === currentSessionId)) {
      const fallbackLink = terminalNotice.pattern.actionLink?.trim() || '';
      const resolved: NoticeAction = {
        link: candidate.link || fallbackLink,
        serverLabel: candidate.serverLabel,
        serverTitle: candidate.serverTitle,
        serverMessage: candidate.serverMessage,
      };
      noticeActionLinks.set(terminalNotice.key, resolved);
      return resolved;
    }

    const fallback = terminalNotice.pattern.actionLink?.trim();
    if (fallback) {
      const resolved: NoticeAction = { link: fallback };
      noticeActionLinks.set(terminalNotice.key, resolved);
      return resolved;
    }

    return null;
  })();

  // Retry notice: only meaningful while the turn is actually running, and it
  // must not bleed across sessions.
  const retryVisible =
    turnActive &&
    payload !== null &&
    (payload.sessionID ? payload.sessionID === currentSessionId : true);

  if (retryVisible && payload) {
    const action = payload.action ?? null;
    const message = action?.message?.trim() || payload.message?.trim();
    const title = action?.title?.trim() || t('retryStatus.title');
    const link = action?.link?.trim();
    const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;
    const hasMeta = attempt !== null || hasCountdown;

    return (
      <NoticeBar
        variant="warning"
        icon="codicon-sync"
        title={title}
        message={message}
        meta={
          hasMeta ? (
            <>
              {attempt !== null && <span>{t('retryStatus.attempt', { n: attempt })}</span>}
              {hasCountdown && (
                <span>{t('retryStatus.retryIn', { seconds: formatSeconds(retryAt - now) })}</span>
              )}
            </>
          ) : undefined
        }
        action={
          link
            ? {
                label: action?.label?.trim() || t('retryStatus.openLink'),
                onClick: () => handleOpenLink(link),
              }
            : null
        }
        onDismiss={handleDismissRetry}
        dismissLabel={t('retryStatus.dismiss')}
      />
    );
  }

  if (!terminalNotice) {
    return null;
  }

  const terminalTitle =
    terminalAction?.serverTitle?.trim() ||
    t(`errorDiagnostic.${terminalNotice.pattern.code}.title`);

  const terminalMessage =
    terminalAction?.serverMessage?.trim() ||
    terminalNotice.serverText?.trim() ||
    t(`errorDiagnostic.${terminalNotice.pattern.code}.notice`);

  return (
    <NoticeBar
      variant="error"
      icon="codicon-warning"
      title={terminalTitle}
      message={terminalMessage}
      action={
        terminalAction && terminalAction.link
          ? {
              label: t(`errorDiagnostic.${terminalNotice.pattern.code}.upgrade`),
              tooltip: terminalAction.serverTitle || terminalAction.serverLabel || undefined,
              onClick: () => handleOpenLink(terminalAction.link),
            }
          : null
      }
      onDismiss={handleDismissTerminal}
      dismissLabel={t('retryStatus.dismiss')}
    />
  );
};

export default StatusNoticeBar;
