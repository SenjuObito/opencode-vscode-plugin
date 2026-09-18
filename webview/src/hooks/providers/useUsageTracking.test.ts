import { act, renderHook } from '@testing-library/react';
import { useUsageTracking } from './useUsageTracking';

describe('useUsageTracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with daemon status unknown', () => {
    const { result } = renderHook(() => useUsageTracking());

    // 状态未知前：状态栏保持加载中。
    expect(result.current.daemonStatusLoaded).toBe(false);
    expect(result.current.isSdkInstalled('opencode')).toBe(false);
    expect(result.current.isSdkStatusKnown('opencode')).toBe(false);
  });

  it('keeps loading until opencode serve is ready', () => {
    const { result } = renderHook(() => useUsageTracking());

    // daemon 进程已起、但 serve 尚未就绪：状态栏保持加载中（daemonStatusLoaded=false）
    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', {
          detail: JSON.stringify({ alive: true, serveReady: false }),
        })
      );
    });

    expect(result.current.daemonStatusLoaded).toBe(false);
    expect(result.current.isSdkInstalled('opencode')).toBe(true);
    expect(result.current.isSdkStatusKnown('opencode')).toBe(false);

    // serve 真正就绪后才隐藏状态栏、视为状态已知
    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', {
          detail: JSON.stringify({ alive: true, serveReady: true }),
        })
      );
    });

    expect(result.current.daemonStatusLoaded).toBe(true);
    expect(result.current.isSdkInstalled('opencode')).toBe(true);
    expect(result.current.isSdkStatusKnown('opencode')).toBe(true);
  });

  it('enters not-running state when daemon is not alive', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', {
          detail: JSON.stringify({ alive: false, serveReady: false }),
        })
      );
    });

    // daemon 未运行：状态栏切到「未运行」可重试态（daemonStatusLoaded=true，isSdkInstalled=false）
    expect(result.current.daemonStatusLoaded).toBe(true);
    expect(result.current.isSdkInstalled('opencode')).toBe(false);
    expect(result.current.isSdkStatusKnown('opencode')).toBe(true);
  });

  it('falls back to loaded on unparseable payload', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', { detail: 'not-json' })
      );
    });

    // 兜底：解析失败也视为状态已知，避免永久卡在 loading。
    expect(result.current.daemonStatusLoaded).toBe(true);
  });
});
