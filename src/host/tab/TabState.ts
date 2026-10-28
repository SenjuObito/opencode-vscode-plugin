/**
 * Lifecycle state of one webview tab.
 *
 * NEW -> CREATING -> BOUND -> STREAMING -> BOUND
 *  |        |          |
 *  |        +-> NEW    +-> LOADING_HISTORY -> BOUND
 *  +-> LOADING_HISTORY
 * any -> CLOSED
 */
export enum TabState {
	/** No opencode session exists yet. Valid non-error state. */
	NEW = 'NEW',
	/** First send is in flight; the canonical session id has not arrived yet. */
	CREATING = 'CREATING',
	/** A canonical session is bound. */
	BOUND = 'BOUND',
	/** History is being loaded into a tab that had no active turn. */
	LOADING_HISTORY = 'LOADING_HISTORY',
	/** A turn is streaming for this tab. */
	STREAMING = 'STREAMING',
	/** Closed; all events must be rejected. */
	CLOSED = 'CLOSED',
}
