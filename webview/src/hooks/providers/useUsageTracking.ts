import { useCallback, useEffect, useState } from 'react';

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

  useEffect(() => {
    const applyStatus = (raw: unknown) => {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // console.error is the only console level that survives the production build
        // (main.tsx noops log/info/warn) and it is forwarded to the host, where
        // PluginFileLogger writes it to the trace file.
        console.error('[Probe] updateDaemonStatus handler fired: ' + JSON.stringify(data));
        setDaemonAlive(!!data.alive);
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
    console.error('[Probe] updateDaemonStatus listener installed, window.updateDaemonStatus='
      + (typeof window.updateDaemonStatus));

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
    retryDaemonStatus,
    isSdkInstalled,
    isSdkStatusKnown,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
