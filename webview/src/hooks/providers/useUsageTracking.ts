import { useCallback, useEffect, useState } from 'react';

import { CLI_ONLY_PROVIDERS } from './cliProviders';

/**
 * 宿主推送的 daemon / serve 状态（见 host/provider/DaemonStatus.ts）。
 * `phase` 可能缺失（旧协议），此时走 `alive` / `serveReady` 兜底。
 */
interface UpdateDaemonStatusPayload {
  alive?: boolean;
  serveReady?: boolean;
  phase?: 'starting' | 'ready' | 'failed';
  code?: string;
  detail?: string;
  installCmd?: string;
}

/** 拉取 opencode serve 失败时的具体原因，供状态栏展示。 */
export interface DaemonIssue {
  /** 面向用户的分类码，对应 `chat.daemonIssue.<code>` 文案。 */
  code: string;
  /** ai-bridge 的原始报错 / stderr 尾巴，可为空。 */
  detail?: string;
  /** opencode 未安装时的安装命令，提供一键复制。 */
  installCmd?: string;
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
  const [daemonIssue, setDaemonIssue] = useState<DaemonIssue | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      try {
        const detail = (event as CustomEvent).detail;
        const data: UpdateDaemonStatusPayload =
          typeof detail === 'string' ? JSON.parse(detail) : detail;
        setDaemonAlive(!!data.alive);

        switch (data.phase) {
          case 'starting':
            // 宿主正在拉起 daemon / serve：状态栏保持转圈，并清掉上一次的失败原因。
            setDaemonStatusLoaded(false);
            setDaemonIssue(null);
            break;
          case 'ready':
            // opencode serve 真正就绪：收起状态栏。
            setDaemonStatusLoaded(true);
            setDaemonIssue(null);
            break;
          case 'failed':
            // 拉不起来：收起转圈，展示具体原因（未安装 / 超时 / 意外退出 …），
            // 而不是一句没有信息量的「serve 未运行」。
            setDaemonStatusLoaded(true);
            setDaemonIssue({
              code: data.code || 'UNKNOWN',
              detail: data.detail,
              installCmd: data.installCmd,
            });
            break;
          default:
            // 旧协议兜底：alive=false（进程没起来）或 serveReady=true（就绪）都算状态已知。
            if (data.alive === false || data.serveReady === true) {
              setDaemonStatusLoaded(true);
            }
            break;
        }
      } catch {
        // 兜底：解析失败也视为状态已知，避免永久卡在 loading。
        setDaemonStatusLoaded(true);
      }
    };
    window.addEventListener('updateDaemonStatus', handler as EventListener);
    return () => window.removeEventListener('updateDaemonStatus', handler as EventListener);
  }, []);

  const isSdkInstalled = useCallback(
    (_providerId: string): boolean => {
      if (CLI_ONLY_PROVIDERS.has(_providerId)) return true;
      return daemonAlive;
    },
    [daemonAlive],
  );

  const isSdkStatusKnown = useCallback((_providerId: string): boolean => {
    if (CLI_ONLY_PROVIDERS.has(_providerId)) return true;
    return daemonStatusLoaded;
  }, [daemonStatusLoaded]);

  const retryDaemonStatus = useCallback(() => {
    setDaemonStatusLoaded(false);
    setDaemonIssue(null);
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
    daemonIssue,
    retryDaemonStatus,
    isSdkInstalled,
    isSdkStatusKnown,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
