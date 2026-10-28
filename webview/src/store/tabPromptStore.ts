/**
 * Per-tab permission/question dialogs that are still waiting for the user.
 *
 * The dialog store renders only the active tab's prompts, so the saved copy has
 * to be keyed by tab id: a prompt owned by a background tab must be waiting
 * again when that tab is selected, and must disappear when the tab closes.
 */
export interface TabPromptSnapshot {
  permissions: any[];
  questions: any[];
  /** Plan approvals waiting for an answer. */
  plans?: any[];
}

export class TabPromptStore {
  private readonly snapshots = new Map<string, TabPromptSnapshot>();

  get(tabId: string): TabPromptSnapshot | undefined {
    return this.snapshots.get(tabId);
  }

  set(tabId: string, snapshot: TabPromptSnapshot): void {
    this.snapshots.set(tabId, snapshot);
  }

  delete(tabId: string): void {
    this.snapshots.delete(tabId);
  }

  size(): number {
    return this.snapshots.size;
  }
}
