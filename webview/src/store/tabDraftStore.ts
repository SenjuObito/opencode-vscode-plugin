export interface TabDraft {
  text: string;
  attachments: any[];
  fileTags: any[];
  quotes?: Record<string, { text: string }>;
}

/**
 * Draft input owned by each tab, independent from messages and streaming state.
 */
export class TabDraftStore {
  private readonly drafts = new Map<string, TabDraft>();

  get(tabId: string): TabDraft | undefined {
    return this.drafts.get(tabId);
  }

  set(tabId: string, draft: TabDraft): void {
    this.drafts.set(tabId, draft);
  }

  delete(tabId: string): void {
    this.drafts.delete(tabId);
  }

  getAll(): TabDraft[] {
    return Array.from(this.drafts.values());
  }

  clear(): void {
    this.drafts.clear();
  }
}
