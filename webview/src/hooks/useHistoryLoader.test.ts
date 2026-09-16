vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

import { act, renderHook } from '@testing-library/react';
import { sendBridgeEvent } from '../utils/bridge';
import { useHistoryLoader } from './useHistoryLoader';

function dispatchDaemonStatus(payload: Record<string, unknown>): void {
  window.dispatchEvent(
    new CustomEvent('updateDaemonStatus', { detail: JSON.stringify(payload) }),
  );
}

/** 首屏请求是挂载后 50ms 的 setTimeout，测试里推进假时钟把它放出来。 */
function flushInitialRequest(): void {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

describe('useHistoryLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.sendToJava;
  });

  it('requests the history list when entering the history view', () => {
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'opencode' }));

    expect(sendBridgeEvent).not.toHaveBeenCalled();
    flushInitialRequest();

    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(sendBridgeEvent).toHaveBeenCalledWith('load_history_data', 'opencode');
  });

  it('does not request while another view is active', () => {
    renderHook(() => useHistoryLoader({ currentView: 'chat', currentProvider: 'opencode' }));
    flushInitialRequest();

    expect(sendBridgeEvent).not.toHaveBeenCalled();
  });

  it('re-requests once opencode serve becomes ready', () => {
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'opencode' }));
    flushInitialRequest();
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);

    // serve 还没起来 → 这一次不算就绪，不补投。
    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: false });
    });
    flushInitialRequest();
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);

    // serve 就绪 → 首屏那次可能已是废数据，补投一次。
    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();
    expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
  });

  it('does not re-request on repeated serveReady payloads', () => {
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'opencode' }));
    flushInitialRequest();

    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();
    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();

    expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
  });

  it('re-requests when serve becomes ready again after a restart', () => {
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'opencode' }));
    flushInitialRequest();

    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();
    act(() => {
      dispatchDaemonStatus({ alive: false, serveReady: false });
    });
    flushInitialRequest();
    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();

    expect(sendBridgeEvent).toHaveBeenCalledTimes(3);
  });

  it('defers the re-request until the history view is active', () => {
    const { rerender } = renderHook(
      ({ view }: { view: 'chat' | 'history' }) =>
        useHistoryLoader({ currentView: view, currentProvider: 'opencode' }),
      { initialProps: { view: 'chat' as 'chat' | 'history' } },
    );

    // 用户不在 history 视图：serve 就绪不该触发请求。
    act(() => {
      dispatchDaemonStatus({ alive: true, serveReady: true });
    });
    flushInitialRequest();
    expect(sendBridgeEvent).not.toHaveBeenCalled();

    // 切到 history：补一次（不是两次——就绪状态已经记下了）。
    rerender({ view: 'history' });
    flushInitialRequest();
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores unparseable daemon status payloads', () => {
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'opencode' }));
    flushInitialRequest();

    act(() => {
      window.dispatchEvent(new CustomEvent('updateDaemonStatus', { detail: 'not-json' }));
    });
    flushInitialRequest();

    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
  });
});
