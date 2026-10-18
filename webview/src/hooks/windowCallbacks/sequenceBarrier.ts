/**
 * sequenceBarrier.ts
 *
 * Provides per-session sequence barrier tracking for updateMessages and onStreamEnd.
 * Prevents race conditions where a high sequence number from an active conversation
 * in one session permanently blocks message snapshots of another freshly loaded or
 * switched session whose Coalescer sequence starts from 0 or 1.
 */

import { parseSequence } from './parseSequence';

export { parseSequence };

/**
 * Retrieves the minimum accepted update sequence for a given session.
 *
 * Strictly per-session. There is deliberately **no** global fallback any more:
 * a single shared baseline let one session's high sequence number permanently
 * block the snapshots of another session that had just been loaded or switched
 * to (whose coalescer restarts at 0). An unknown session gets a fresh baseline
 * of 0, i.e. accept — the permissive direction, because dropping a snapshot is
 * invisible to the user while blocking one freezes the whole tab.
 */
export const getMinAcceptedSequence = (sessionId?: string | null): number => {
  if (!sessionId || !window.__sessionMinAcceptedUpdateSequence) {
    return 0;
  }
  let sessionSeq: number | undefined;
  if (window.__sessionMinAcceptedUpdateSequence instanceof Map) {
    sessionSeq = window.__sessionMinAcceptedUpdateSequence.get(sessionId);
  } else {
    sessionSeq = (window.__sessionMinAcceptedUpdateSequence as Record<string, number>)[sessionId];
  }
  return typeof sessionSeq === 'number' && Number.isFinite(sessionSeq) ? sessionSeq : 0;
};

/**
 * Checks whether the given session is considered the active foreground session in the UI.
 *
 * An empty id is **not** the foreground session. Treating it as such is what let
 * an unattributable write adopt the active tab's sequence baseline.
 */
const isForegroundSession = (sessionId?: string | null): boolean => {
  if (!sessionId) return false;
  if (sessionId === window.__sessionTransitionTargetSessionId) return true;
  if (window.__sessionTabsStore?.isActiveSession(sessionId)) return true;
  return false;
};

/**
 * Advances the minimum accepted sequence for a session monotonically (Math.max).
 */
export const advanceMinAcceptedSequence = (
  sessionId: string | null | undefined,
  sequence: number,
): void => {
  if (sessionId) {
    if (!window.__sessionMinAcceptedUpdateSequence) {
      window.__sessionMinAcceptedUpdateSequence = new Map<string, number>();
    }
    const current = getMinAcceptedSequence(sessionId);
    const next = Math.max(current, sequence);
    if (window.__sessionMinAcceptedUpdateSequence instanceof Map) {
      window.__sessionMinAcceptedUpdateSequence.set(sessionId, next);
    } else {
      (window.__sessionMinAcceptedUpdateSequence as Record<string, number>)[sessionId] = next;
    }
  }

  // `isForegroundSession` is retained for the (still meaningful) case of a
  // *known* session that is currently on screen; the shared global baseline it
  // used to also advance has been removed — see getMinAcceptedSequence.
  if (isForegroundSession(sessionId)) {
    window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, sequence);
  }
};

/**
 * Resets the barrier sequence for a session (explicit assignment, NOT Math.max).
 * Used by clearMessages to establish a fresh sequence baseline for newly loaded or reset sessions,
 * ensuring prior high-sequence turns from other sessions cannot block the new session's incoming messages.
 */
export const resetMinAcceptedSequence = (
  sessionId: string | null | undefined,
  barrierSequence: number,
): void => {
  if (sessionId) {
    if (!window.__sessionMinAcceptedUpdateSequence) {
      window.__sessionMinAcceptedUpdateSequence = new Map<string, number>();
    }
    if (window.__sessionMinAcceptedUpdateSequence instanceof Map) {
      window.__sessionMinAcceptedUpdateSequence.set(sessionId, barrierSequence);
    } else {
      (window.__sessionMinAcceptedUpdateSequence as Record<string, number>)[sessionId] = barrierSequence;
    }
  }

  // When resetting the active foreground session, reset the global fallback baseline too
  if (isForegroundSession(sessionId)) {
    window.__minAcceptedUpdateSequence = barrierSequence;
  }
};

/**
 * Clears the sequence barrier entry for a session when it is closed or deleted.
 */
export const clearSessionSequenceBarrier = (sessionId: string): void => {
  if (!sessionId || !window.__sessionMinAcceptedUpdateSequence) return;
  if (window.__sessionMinAcceptedUpdateSequence instanceof Map) {
    window.__sessionMinAcceptedUpdateSequence.delete(sessionId);
  } else {
    delete (window.__sessionMinAcceptedUpdateSequence as Record<string, number>)[sessionId];
  }
};
