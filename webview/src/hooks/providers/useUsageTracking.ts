import { useCallback, useEffect, useState } from 'react';
import { cardDebugLog } from '../../utils/bridge';

/**
 * OpenCode engine resolution snapshot reported by daemon / core.
 */
export interface DaemonEngineStatus {
  state?: 'pending' | 'v1' | 'v2' | 'unknown' | string;
  locked?: boolean;
  blocking?: boolean;
  cliPath?: string | null;
  cliSource?: string | null;
  cliVersion?: string | null;
  probePath?: string | null;
  httpStatus?: number | string | null;
  apiVersion?: number | string | null;
  reasonKind?: string | null;
  reasonMessage?: string | null;
  ts?: number;
}

/**
 * Usage % / token counters and daemon alive status.
 * `isSdkInstalled(providerId)` now simply checks if the opencode daemon is alive.
 */
export function useUsageTracking() {
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [daemonAlive, setDaemonAlive] = useState(false);
  const [daemonStatusLoaded, setDaemonStatusLoaded] = useState(false);
  const [daemonEngine, setDaemonEngine] = useState<DaemonEngineStatus | null>(null);

  useEffect(() => {
    const applyStatus = (raw: unknown) => {
      try {
        let data: any = raw;
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }
        if (data && typeof data === 'object' && 'data' in data) {
          const inner = (data as { data?: unknown }).data;
          if (typeof inner === 'string') {
            data = JSON.parse(inner);
          } else if (inner && typeof inner === 'object') {
            data = inner;
          }
        }
        cardDebugLog('[Probe] updateDaemonStatus handler fired:', JSON.stringify(data));
        setDaemonAlive(!!data.alive);
        if (data.engine && typeof data.engine === 'object') {
          setDaemonEngine(data.engine as DaemonEngineStatus);
          if (data.engine.state === 'unknown' || data.engine.blocking) {
            console.warn(
              '[Engine] opencode engine not usable:',
              data.engine.state,
              data.engine.reasonKind || '',
              data.engine.reasonMessage || '',
            );
          }
        } else if (data.engine === null) {
          setDaemonEngine(null);
        }
        // 状态栏（"正在检查 opencode serve 状态..."）必须等到 serve 真正就绪
        // （serveReady=true）才消失；serve 进程都没运行（alive=false）则立即进入
        // 「未运行」可重试态；alice 为真但 serve 尚未就绪时保持 loading 转圈。
        if (data.alive === false || data.serveReady === true) {
          setDaemonStatusLoaded(true);
        }
        // 其余情况（alive=true && serveReady=false/缺失）保持 daemonStatusLoaded=false，
        // 状态栏继续显示加载中，直到宿主发来 serveReady:true。
      } catch {
        // 兜底：解析失败也视为状态已知，避免永久卡在 loading。
        setDaemonStatusLoaded(true);
      }
    };

    const handler = (event: Event) => {
      applyStatus((event as CustomEvent).detail);
    };

    window.addEventListener('updateDaemonStatus', handler as EventListener);
    cardDebugLog(
      '[Probe] updateDaemonStatus listener installed, window.updateDaemonStatus='
      + (typeof window.updateDaemonStatus),
    );

    // Drain any status that arrived before this listener was attached.
    // main.tsx stores the latest payload in window.__pendingDaemonStatus.
    if (typeof window.__pendingDaemonStatus === 'string') {
      const pending = window.__pendingDaemonStatus;
      delete window.__pendingDaemonStatus;
      applyStatus(pending);
    }

    return () => window.removeEventListener('updateDaemonStatus', handler as EventListener);
  }, []);

  const isSdkInstalled = useCallback(
    (_providerId: string): boolean => {
      return daemonAlive;
    },
    [daemonAlive],
  );

  const isSdkStatusKnown = useCallback((_providerId: string): boolean => {
    return daemonStatusLoaded;
  }, [daemonStatusLoaded]);

  const retryDaemonStatus = useCallback(() => {
    setDaemonStatusLoaded(false);
    if (window.sendToJava) {
      window.sendToJava('check_daemon_status:');
    }
  }, []);

  return {
    usagePercentage,
    setUsagePercentage,
    usageUsedTokens,
    setUsageUsedTokens,
    usageMaxTokens,
    setUsageMaxTokens,
    daemonStatusLoaded,
    daemonEngine,
    retryDaemonStatus,
    isSdkInstalled,
    isSdkStatusKnown,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
