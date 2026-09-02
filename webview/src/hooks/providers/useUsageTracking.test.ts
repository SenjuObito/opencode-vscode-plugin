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
    // opencode 是 CLI-only provider，isSdkInstalled 恒为 true。
    expect(result.current.isSdkInstalled('opencode')).toBe(true);
    // 非 CLI-only provider（如 claude）在未就绪前视为未安装。
    expect(result.current.isSdkInstalled('claude')).toBe(false);
  });

  it('keeps loading until opencode serve is ready', () => {
    const { result } = renderHook(() => useUsageTracking());

    // daemon 进程已起、但 serve 尚未就绪：状态栏保持加载中（daemonStatusLoaded=false），
    // 此时非 CLI-only provider 既未安装、状态也未知。
    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', {
          detail: JSON.stringify({ alive: true, serveReady: false }),
        })
      );
    });

    expect(result.current.daemonStatusLoaded).toBe(false);
    // daemon 已存活 → 视为已安装；但状态栏仍在 loading（状态未确定）→ isSdkStatusKnown 为 false。
    expect(result.current.isSdkInstalled('claude')).toBe(true);
    expect(result.current.isSdkStatusKnown('claude')).toBe(false);

    // serve 真正就绪后才隐藏状态栏、视为已安装/已知。
    act(() => {
      window.dispatchEvent(
        new CustomEvent('updateDaemonStatus', {
          detail: JSON.stringify({ alive: true, serveReady: true }),
        })
      );
    });

    expect(result.current.daemonStatusLoaded).toBe(true);
    expect(result.current.isSdkInstalled('claude')).toBe(true);
    expect(result.current.isSdkStatusKnown('claude')).toBe(true);
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

    // daemon 未运行：状态栏切到「未运行」可重试态（daemonStatusLoaded=true，
    // 即状态已确定），但非 CLI-only provider 仍视为未安装、状态未知。
    expect(result.current.daemonStatusLoaded).toBe(true);
    expect(result.current.isSdkInstalled('claude')).toBe(false);
    expect(result.current.isSdkStatusKnown('claude')).toBe(true);
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

  it('treats CLI-only providers as always installed/known', () => {
    const { result } = renderHook(() => useUsageTracking());

    // 无论 daemon 状态如何，opencode（CLI-only）恒为已安装/已知。
    expect(result.current.isSdkInstalled('opencode')).toBe(true);
    expect(result.current.isSdkStatusKnown('opencode')).toBe(true);
  });
});
