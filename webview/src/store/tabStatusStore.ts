/**
 * Per-tab status snapshot taken at a tab-switch boundary.
 *
 * The rendered values still live in React state (one viewport, one set of
 * setters), but the saved copy belongs to the tab, not to the hook. Keeping it
 * in a small store means a background update can never overwrite the status the
 * outgoing tab will restore, and closing a tab drops its copy with it.
 */
import type { SessionTabData } from '../components/ChatHeader/types';

export interface TabStatusSnapshot {
  loading: boolean;
  streamingActive: boolean;
  isThinking: boolean;
  status: string;
  revertBoundaryId: string | null;
  isCompacting: boolean;
  compactingStartTime: number | null;
  taskEvents: Record<string, any>;
  sseTodos: any[] | null;
  subagentHistories: Record<string, any>;
  filteredFileChanges: any[];
  turnStartedAt: number | null;
  usagePercentage: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
}

/** Snapshot a tab's live status fields; background updates write there first. */
export function statusSnapshotOf(tab: SessionTabData): TabStatusSnapshot {
  return {
    loading: tab.loading ?? false,
    streamingActive: tab.streamingActive ?? false,
    isThinking: tab.isThinking ?? false,
    status: tab.status ?? '',
    revertBoundaryId: tab.revertBoundaryId ?? null,
    isCompacting: tab.isCompacting ?? false,
    compactingStartTime: tab.compactingStartTime ?? null,
    taskEvents: tab.taskEvents ?? {},
    sseTodos: tab.sseTodos ?? null,
    subagentHistories: tab.subagentHistories ?? {},
    filteredFileChanges: tab.filteredFileChanges ?? [],
    turnStartedAt: tab.turnStartedAt ?? null,
    usagePercentage: tab.usagePercentage ?? 0,
    usageUsedTokens: tab.usageUsedTokens,
    usageMaxTokens: tab.usageMaxTokens,
  };
}

export class TabStatusStore {
  private readonly snapshots = new Map<string, TabStatusSnapshot>();

  get(tabId: string): TabStatusSnapshot | undefined {
    return this.snapshots.get(tabId);
  }

  set(tabId: string, snapshot: TabStatusSnapshot): void {
    this.snapshots.set(tabId, snapshot);
  }

  delete(tabId: string): void {
    this.snapshots.delete(tabId);
  }

  size(): number {
    return this.snapshots.size;
  }
}
