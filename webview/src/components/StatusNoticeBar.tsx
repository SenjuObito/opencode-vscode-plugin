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
import type { HostEventEnvelope } from '../utils/hostEventTypes';
import { sendToJava } from '../utils/bridge';
import type { DaemonEngineStatus } from '../hooks/providers/useUsageTracking';
import './StatusNoticeBar.less';

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
 * Terminal error pushed directly by the host (`turn.error`).
 *
 * <p>The transcript snapshot can briefly shrink while a turn settles, and a
 * quota error that only exists in a message row can disappear before the user
 * sees it. The host therefore publishes the same error as a semantic event; it
 * is the authoritative source for the terminal notice.</p>
 */
export interface TerminalErrorPayload {
  sessionId: string | null;
  message: string;
  timestamp: number;
}

let latestTerminalError: TerminalErrorPayload | null = null;
const terminalErrorListeners = new Set<(payload: TerminalErrorPayload | null) => void>();

export const setTerminalError = (payload: TerminalErrorPayload | null): void => {
  latestTerminalError = payload;
  terminalErrorListeners.forEach((listener) => listener(payload));
};

export const getTerminalError = (): TerminalErrorPayload | null => latestTerminalError;

/**
 * Bridge entry point for `turn.error`.
 *
 * The host sends `{ error: "<message>" }`; older payloads may carry the JSON
 * string directly. Both forms are reduced to the human-readable message here.
 */
export const onTerminalErrorFromHost = (payload?: unknown, env?: HostEventEnvelope): void => {
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null;
  const raw = typeof payload === 'string'
    ? payload
    : (record?.error ?? record?.message);
  let message = typeof raw === 'string' ? raw.trim() : '';
  if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      const nested = parsed.message ?? (parsed.error as Record<string, unknown> | undefined)?.message;
      if (typeof nested === 'string' && nested.trim()) {
        message = nested.trim();
      }
    } catch {
      // Keep the raw message; it is still better than hiding the failure.
    }
  }
  if (!message) {
    setTerminalError(null);
    return;
  }
  setTerminalError({
    sessionId: env?.sessionId ?? null,
    message,
    timestamp: Date.now(),
  });
};

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
 * Identity of a notice: session + diagnostic pattern.
 *
 * <p>The semantic `turn.error` event and the transcript error row are two
 * representations of the same failure, and their timestamps differ. Keying by
 * the matched diagnosis (falling back to the text digest) makes dismissing one
 * representation dismiss both. A timestamp in the key is what let a dismissed
 * quota notice reappear after a later successful turn.</p>
 */
export const noticeKeyFor = (
  sessionId: string | null,
  message: ClaudeMessage,
  text: string,
  turnAnchor?: string | number | null,
): string => {
  const pattern = matchErrorPattern(text);
  // The turn anchor is the prompt that opened this turn. The semantic event
  // and the transcript row share it, while a later turn gets a new one. When
  // there is no prompt yet (history replay), fall back to the row timestamp so
  // two distinct errors in the same snapshot remain distinguishable.
  const anchor = turnAnchor != null && String(turnAnchor).length > 0
    ? String(turnAnchor)
    : String(Number(message.timestamp) || 0);
  return `${sessionId ?? ''}::${anchor}::${pattern?.code ?? hashText(text.slice(0, 200))}`;
};

/**
 * Whether a user-role row is the prompt that opened a turn, rather than a
 * synthetic tool_result row that happened inside it. The terminal notice only
 * belongs to the newest turn; an error from an older turn must not resurface
 * after a successful reply.
 */
function isUserPromptMessage(
  message: ClaudeMessage,
  getMessageText: (message: ClaudeMessage) => string,
): boolean {
  if (message.type !== 'user') return false;

  let raw = message.raw as unknown;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const nested = record?.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null;
  const content = record?.content ?? nested?.content;

  if (Array.isArray(content) && content.length > 0) {
    return content.some((block) => (
      block && typeof block === 'object'
        && (block as { type?: unknown }).type !== 'tool_result'
    ));
  }
  if (typeof content === 'string' && content.trim() === '[tool_result]') {
    return false;
  }
  if (typeof message.content === 'string' && message.content.trim() === '[tool_result]') {
    return false;
  }
  return (getMessageText(message) ?? '').trim().length > 0;
}

function findLatestUserPrompt(
  messages: ClaudeMessage[],
  getMessageText: (message: ClaudeMessage) => string,
): ClaudeMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isUserPromptMessage(messages[i], getMessageText)) {
      return messages[i];
    }
  }
  return undefined;
}

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
export const onRetryStatusFromHost = (arg0?: unknown, arg1?: unknown): void => {
  let raw = typeof arg1 !== 'undefined' ? arg1 : arg0;
  if (!raw) {
    setRetryStatus(null);
    return;
  }
  // When sent via named TabEvent, envelope payload is { retry: { ... } }
  if (typeof raw === 'object' && raw !== null && 'retry' in (raw as Record<string, unknown>)) {
    raw = (raw as Record<string, unknown>).retry;
  }
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
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
    return;
  }
  if (typeof raw === 'object' && raw !== null) {
    setRetryStatus(raw as RetryStatusPayload);
    return;
  }
  setRetryStatus(null);
};

/** Test-only: reset the module-level caches between cases. */
export const __resetNoticeStateForTest = (): void => {
  latestRetryStatus = null;
  pendingRetryAction = null;
  latestTerminalError = null;
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
  /** Daemon engine state: when blocked, the bar explains how to recover. */
  engine?: DaemonEngineStatus | null;
  onRetryEngine?: () => void;
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
  onDismiss?: () => void;
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
    {onDismiss && (
      <button
        type="button"
        className="status-notice-dismiss"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <span className="codicon codicon-close" />
      </button>
    )}
  </div>
);

export const StatusNoticeBar = ({
  messages: propMessages,
  getMessageText: propGetMessageText,
  engine = null,
  onRetryEngine,
}: StatusNoticeBarProps = {}) => {
  const { t } = useTranslation();
  const messagesCtx = useMessages();
  const sessionCtx = useSession();

  const messages = propMessages ?? messagesCtx.messages ?? [];
  const getMessageText = propGetMessageText ?? defaultGetMessageText;
  const turnActive = messagesCtx.loading || messagesCtx.streamingActive;
  const sessionLoading = messagesCtx.sessionLoading;
  const currentSessionId = sessionCtx.currentSessionId ?? null;

  const [payload, setPayload] = useState<RetryStatusPayload | null>(getRetryStatus);
  const [directTerminalError, setDirectTerminalErrorState] = useState<TerminalErrorPayload | null>(getTerminalError);
  const [now, setNow] = useState(() => Date.now());
  // The dismissed set lives module-side and is not reactive; bumping this
  // counter is what makes a dismissal re-evaluate the notice.
  const [dismissVersion, setDismissVersion] = useState(0);

  const terminalNotice = useMemo<TerminalNotice | null>(() => {
    // A notice raised by a transcript that is still being restored is not
    // something the user can act on yet.
    if (sessionLoading) return null;

    // Anchor both representations of an error to the prompt that opened the
    // turn, not to their own timestamps.
    const turnAnchor = findLatestUserPrompt(messages, getMessageText)?.timestamp;

    // Prefer the semantic `turn.error` event. It is not tied to a transcript
    // snapshot and therefore survives a shorter user-only snapshot.
    const direct = directTerminalError;
    if (direct && (!direct.sessionId || direct.sessionId === currentSessionId)) {
      const pattern = matchErrorPattern(direct.message);
      if (pattern?.presentation === 'bar') {
        const pseudo: ClaudeMessage = {
          type: 'error',
          content: direct.message,
          timestamp: String(direct.timestamp),
        };
        const key = noticeKeyFor(direct.sessionId ?? currentSessionId, pseudo, direct.message, turnAnchor);
        if (dismissedNoticeKeys.has(key)) return null;
        return { key, pattern, serverText: direct.message };
      }
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      // Only the newest turn owns a terminal notice. If the scan reaches the
      // prompt that opened it, older errors must not be resurrected.
      if (isUserPromptMessage(message, getMessageText)) break;
      if (message.type !== 'error') continue;

      const text = getMessageText(message) ?? '';
      const pattern = matchErrorPattern(text);
      // `card` patterns keep their inline diagnostic card; only `bar` patterns
      // are promoted here.
      if (!pattern || pattern.presentation !== 'bar') continue;

      const key = noticeKeyFor(currentSessionId, message, text, turnAnchor);
      // Only the last such error is ever shown: if it was dismissed, the notice
      // is gone — older ones must not resurface in its place.
      if (dismissedNoticeKeys.has(key)) return null;

      return { key, pattern, serverText: text };
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissVersion is a re-evaluation trigger, not an input
  }, [messages, getMessageText, sessionLoading, currentSessionId, dismissVersion, directTerminalError]);

  useEffect(() => {
    const listener = (next: RetryStatusPayload | null) => setPayload(next);
    retryStatusListeners.add(listener);
    return () => {
      retryStatusListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const listener = (next: TerminalErrorPayload | null) => setDirectTerminalErrorState(next);
    terminalErrorListeners.add(listener);
    return () => {
      terminalErrorListeners.delete(listener);
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

    // A new turn invalidates the previous turn's terminal notice. Without this
    // the old quota error stayed in module state and could be re-keyed (or
    // re-emitted by a reactivated session) after a later successful reply.
    pendingRetryAction = null;
    noticeActionLinks.clear();
    setTerminalError(null);
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
    sendToJava('open_external_url', link);
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

  const engineBlocked = !!engine && (engine.blocking === true || engine.state === 'unknown');
  if (engineBlocked) {
    const meta = [engine.cliVersion, engine.cliSource, engine.apiVersion ? `API ${engine.apiVersion}` : null]
      .filter((part): part is string => !!part && String(part).trim().length > 0);
    return (
      <NoticeBar
        variant="error"
        icon="codicon-debug-disconnect"
        title={t('engineNotice.title')}
        message={engine.reasonMessage?.trim() || t('engineNotice.message')}
        meta={meta.length > 0 ? <span>{meta.join(' · ')}</span> : undefined}
        action={onRetryEngine ? { label: t('engineNotice.retry'), onClick: onRetryEngine } : null}
        dismissLabel={t('retryStatus.dismiss')}
      />
    );
  }

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
