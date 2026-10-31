/**
 * SessionHistoryWindow — how much of a tab's transcript has been read back
 * from the engine, and where the next older page starts.
 *
 * <p>opencode 2.x pages `/api/session/{id}/message` (default page 50, max 200,
 * cursor based). A tab therefore holds a *window* of the transcript, not the
 * whole thing: the newest page on open, plus every page the user asked for.
 * The window lives on the session, which is 1:1 with a tab, so two tabs on the
 * same transcript each page independently and a tab switch cannot move one
 * tab's cursor into another.</p>
 *
 * <p>`generation` guards late responses: a reload (or a rebind to another
 * session) resets the window and bumps the counter, so an in-flight page for
 * the previous transcript is dropped instead of being prepended to the new
 * one.</p>
 */
export interface HistoryWindowSnapshot {
	sessionId: string | null;
	/** There is at least one older page on the server. */
	hasEarlier: boolean;
	/** Cursor of that older page (`cursor.next` of the current window). */
	earlierCursor: string | null;
	/** Transcript records currently held by this tab. */
	loadedCount: number;
	/** Page size the host requests (server max). */
	pageSize: number;
	/** User turns inside the loaded window. */
	loadedTurns: number;
	/** User turns in the whole session; null until the count came back. */
	totalTurns: number | null;
	/** A page request is in flight. */
	loading: boolean;
}

export const DEFAULT_HISTORY_PAGE_SIZE = 200;

export class SessionHistoryWindow {
	private sessionId: string | null = null;
	private earlierCursor: string | null = null;
	private hasEarlier = false;
	private loadedCount = 0;
	private pageSize = DEFAULT_HISTORY_PAGE_SIZE;
	private loadedTurns = 0;
	private totalTurns: number | null = null;
	private loading = false;
	/** Bumped whenever the window is replaced; stale responses carry an old one. */
	private generation = 0;

	getGeneration(): number {
		return this.generation;
	}

	getPageSize(): number {
		return this.pageSize;
	}

	getEarlierCursor(): string | null {
		return this.earlierCursor;
	}

	hasEarlierPages(): boolean {
		return this.hasEarlier;
	}

	isLoading(): boolean {
		return this.loading;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}

	/**
	 * A whole new transcript replaced the window (open / reload / reset).
	 * Every paging fact of the previous transcript is void.
	 */
	reset(sessionId: string | null): void {
		this.generation += 1;
		this.sessionId = sessionId;
		this.earlierCursor = null;
		this.hasEarlier = false;
		this.loadedCount = 0;
		this.loadedTurns = 0;
		this.totalTurns = null;
		this.loading = false;
	}

	/** The newest page was just loaded and replaced the transcript. */
	applyFirstPage(input: {
		sessionId: string | null;
		loadedCount: number;
		loadedTurns: number;
		cursor: string | null;
		hasEarlier: boolean;
		pageSize?: number;
	}): void {
		this.reset(input.sessionId);
		if (input.pageSize && input.pageSize > 0) {
			this.pageSize = input.pageSize;
		}
		this.loadedCount = Math.max(0, input.loadedCount);
		this.loadedTurns = Math.max(0, input.loadedTurns);
		this.earlierCursor = input.cursor;
		this.hasEarlier = input.hasEarlier && Boolean(input.cursor);
	}

	/**
	 * Claim the right to request the next older page.
	 *
	 * @returns the generation to compare with {@link isCurrent}, or null when
	 *   there is nothing earlier or a request is already in flight (a second
	 *   click must not duplicate the page).
	 */
	beginEarlier(): number | null {
		if (!this.hasEarlier || !this.earlierCursor || this.loading) {
			return null;
		}
		this.loading = true;
		return this.generation;
	}

	/** An older page was prepended. Returns false when the claim is stale. */
	finishEarlier(
		generation: number,
		input: {
			loadedCount: number;
			loadedTurns: number;
			cursor: string | null;
			hasEarlier: boolean;
		},
	): boolean {
		if (!this.isCurrent(generation)) {
			return false;
		}
		this.loading = false;
		this.loadedCount += Math.max(0, input.loadedCount);
		this.loadedTurns += Math.max(0, input.loadedTurns);
		this.earlierCursor = input.cursor;
		this.hasEarlier = input.hasEarlier && Boolean(input.cursor);
		return true;
	}

	/** The page request failed (or came back empty): leave the cursor alone. */
	failEarlier(generation: number): boolean {
		if (!this.isCurrent(generation)) {
			return false;
		}
		this.loading = false;
		return true;
	}

	setTotalTurns(total: number | null): void {
		this.totalTurns = total != null && total >= 0 ? total : null;
	}

	snapshot(sessionId?: string | null): HistoryWindowSnapshot {
		return {
			sessionId: this.sessionId ?? sessionId ?? null,
			hasEarlier: this.hasEarlier,
			earlierCursor: this.earlierCursor,
			loadedCount: this.loadedCount,
			pageSize: this.pageSize,
			loadedTurns: this.loadedTurns,
			totalTurns: this.totalTurns,
			loading: this.loading,
		};
	}
}
