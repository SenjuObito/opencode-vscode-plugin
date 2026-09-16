import { useEffect, useRef, useState } from 'react';
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
export function useHistoryLoader(options: UseHistoryLoaderOptions): void {
  const { currentView, currentProvider } = options;

  // serve 就绪的边沿计数：false→true 时才递增（daemon 重启后再次就绪也算一次）。
  const [serveReadyTick, setServeReadyTick] = useState(0);
  const serveReadyRef = useRef(false);

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

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    let historyRetryCount = 0;
    const MAX_HISTORY_RETRIES = 30;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;

    const requestHistoryData = () => {
      if (window.sendToJava) {
        sendBridgeEvent('load_history_data', currentProvider);
      } else {
        historyRetryCount++;
        if (historyRetryCount < MAX_HISTORY_RETRIES) {
          currentTimer = setTimeout(requestHistoryData, 100);
        } else {
          console.warn('[Frontend] Failed to load history data: bridge not available after', MAX_HISTORY_RETRIES, 'retries');
        }
      }
    };

    currentTimer = setTimeout(requestHistoryData, 50);

    return () => {
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
    };
  }, [currentView, currentProvider, serveReadyTick]);
}
