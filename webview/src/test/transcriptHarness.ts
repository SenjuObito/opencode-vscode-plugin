/**
 * Transcript helpers for tests.
 *
 * <p>The transcript is owned by the tab store, so a test that used to keep a
 * local `messages` buffer reads and writes through the store instead. These
 * helpers keep that boilerplate in one place.</p>
 */
import type { ClaudeMessage } from '../types';
import { getTabStore, resetTabStore } from '../store/tabStore';
import type { TabTranscript } from '../store/tabTranscript';

/** Start every transcript test from an empty store with no tabs. */
export function resetTranscripts(): void {
  resetTabStore();
}

/** The transcript of the active tab (or the detached tab when there is none). */
export function activeTranscript(): TabTranscript {
  return getTabStore().getActiveTab().transcript;
}

/** The messages the view would render right now. */
export function transcriptMessages(): ClaudeMessage[] {
  return getTabStore().getActiveTabMessages();
}

/** Replace the active transcript's remote segment. */
export function setTranscriptMessages(messages: ClaudeMessage[]): void {
  getTabStore().mutateActiveTranscript((transcript) => transcript.applySnapshot(messages));
}
