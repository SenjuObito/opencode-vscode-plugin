import {
  isDependencyStatusResponse,
  requestFreshDependencyStatus,
  requestDependencyStatusUntilSettled,
  retryDependencyStatusRequest,
  settleDependencyStatusRequest,
  waitForBridge,
} from './bridgeStartup';

describe('bridge startup recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.sendToJava;
    delete window.__ccgOnBridgeReady;
    window.__dependencyStatusState = 'pending';
  });

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('bootstraps once when the bridge appears after the fast retry window', () => {
    const callback = vi.fn();
    waitForBridge(callback);
    const bridgeReady = window.__ccgOnBridgeReady;

    vi.advanceTimersByTime(6000);
    expect(callback).not.toHaveBeenCalled();

    window.sendToJava = vi.fn();
    bridgeReady?.();
    bridgeReady?.();
    vi.runOnlyPendingTimers();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });

  it('cancels bridge polling when the page is hidden', () => {
    const callback = vi.fn();
    waitForBridge(callback);

    window.dispatchEvent(new Event('pagehide'));
    window.sendToJava = vi.fn();
    vi.runOnlyPendingTimers();

    expect(callback).not.toHaveBeenCalled();
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });






});
