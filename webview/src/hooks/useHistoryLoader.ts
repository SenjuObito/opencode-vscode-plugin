import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

export interface UseHistoryLoaderOptions {
  currentView: 'chat' | 'history' | 'settings';
  currentProvider: string;
}

/**
 * 进入 history 视图时请求一次会话列表，并在 opencode serve 就绪时补投一次。
 *
 * 补投的必要性：首次请求在视图挂载后 50ms 就发出，可能赶在 serve 起来之前
 * （或正在重启），那一次的响应不可用；而列表在宿主侧只加载这一次，没有任何
 * 补投机会，结果就是「打开插件列表空白，发了条消息才刷出来」。
 * serve 由未就绪变为就绪 = 现在这次请求大概率能成功，此时补一次即可。
 */
export function useHistoryLoader(options: UseHistoryLoaderOptions): () => void {
  const { currentView, currentProvider } = options;

  // serve 就绪的边沿计数：false→true 时才递增（daemon 重启后再次就绪也算一次）。
  const [serveReadyTick, setServeReadyTick] = useState(0);
  const serveReadyRef = useRef(false);

  /** The bridge may be late; the request is retried a bounded number of times. */
  const MAX_HISTORY_RETRIES = 30;
  const historyRetryCountRef = useRef(0);
  const historyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const applyStatus = (raw: unknown) => {
      let data: { serveReady?: boolean } | null = null;
      try {
        data = typeof raw === 'string' ? JSON.parse(raw) : (raw as { serveReady?: boolean });
      } catch {
        return;
      }
      const ready = data?.serveReady === true;
      if (ready && !serveReadyRef.current) {
        setServeReadyTick((tick) => tick + 1);
      }
      serveReadyRef.current = ready;
    };

    const handler = (event: Event) => {
      applyStatus((event as CustomEvent).detail);
    };

    window.addEventListener('updateDaemonStatus', handler as EventListener);
    return () => window.removeEventListener('updateDaemonStatus', handler as EventListener);
  }, []);

  /**
   * Ask the host for the session list.
   *
   * <p>The bridge may not be ready yet (the panel mounts before the host
   * finishes wiring), so the request is retried a bounded number of times
   * before giving up.</p>
   */
  const requestHistoryData = useCallback(() => {
    if (window.sendToJava) {
      sendBridgeEvent('load_history_data', currentProvider);
      return;
    }
    if (historyRetryCountRef.current < MAX_HISTORY_RETRIES) {
      historyRetryCountRef.current += 1;
      historyRetryTimerRef.current = setTimeout(requestHistoryData, 100);
      return;
    }
    console.warn('[Frontend] Failed to load history data: bridge not available after', MAX_HISTORY_RETRIES, 'retries');
  }, [currentProvider]);

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    historyRetryCountRef.current = 0;
    historyRetryTimerRef.current = setTimeout(requestHistoryData, 50);

    return () => {
      if (historyRetryTimerRef.current) {
        clearTimeout(historyRetryTimerRef.current);
        historyRetryTimerRef.current = null;
      }
    };
  }, [currentView, currentProvider, serveReadyTick, requestHistoryData]);

  /**
   * Reload the list on demand (the history view's retry button).
   */
  const reloadHistory = useCallback(() => {
    if (historyRetryTimerRef.current) {
      clearTimeout(historyRetryTimerRef.current);
      historyRetryTimerRef.current = null;
    }
    historyRetryCountRef.current = 0;
    requestHistoryData();
  }, [requestHistoryData]);

  return reloadHistory;
}
