/**
 * notificationSound —— 通知提示音播放（WebAudio 合成 + 自定义文件解码）。
 *
 * 由宿主 `playNotificationSound` 推送触发（见 src/host/notifications/
 * NotificationService.ts），判定逻辑在宿主，这里只负责发声：
 *   - 5 个内置预设音：default / chime / bell / ding / success
 *   - error 变体：固定低沉双音（不随用户 selectedSound 设置变化）
 *   - custom：宿主下发的 base64 音频数据经 decodeAudioData 播放，
 *     解码失败静默回退 default
 */

type AudioContextCtor = typeof AudioContext;

const getAudioContextCtor = (): AudioContextCtor | null => {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

/** 合成预设音；error 为固定低沉双音。 */
const synthesize = (ctx: AudioContext, soundId: string, variant?: string): void => {
  const now = ctx.currentTime;
  const tone = (freq: number, start: number, duration: number, gainValue = 0.18, type: OscillatorType = 'sine') => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(gainValue, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration);
  };

  if (variant === 'error') {
    // 低沉双音：A3 → E3，与普通提示音明显区分
    tone(220, 0, 0.22, 0.22, 'triangle');
    tone(164.81, 0.18, 0.35, 0.22, 'triangle');
    return;
  }

  switch (soundId) {
    case 'chime':
      tone(523.25, 0, 0.25);
      tone(659.25, 0.12, 0.25);
      tone(783.99, 0.24, 0.35);
      break;
    case 'bell':
      tone(880, 0, 0.3, 0.14);
      tone(1320, 0, 0.3, 0.08);
      break;
    case 'ding':
      tone(1200, 0, 0.15, 0.2);
      break;
    case 'success':
      tone(523.25, 0, 0.12);
      tone(659.25, 0.1, 0.12);
      tone(783.99, 0.2, 0.12);
      tone(1046.5, 0.3, 0.3);
      break;
    case 'default':
    default:
      tone(800, 0, 0.2);
      break;
  }
};

/**
 * 复用同一个 AudioContext。
 *
 * 每次 new 一个再 close 有两个问题：
 *   1) 非用户手势创建的上下文处于 `suspended`，立刻用 currentTime 排程的
 *      音符会被丢弃（浏览器自动播放策略）——这正是"设置开了却没声音"的根因；
 *   2) 频繁创建/销毁在 VS Code webview 里开销明显。
 */
let sharedCtx: AudioContext | null = null;

const acquireContext = (): AudioContext | null => {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    if (!sharedCtx || sharedCtx.state === 'closed') {
      sharedCtx = new Ctor();
    }
    return sharedCtx;
  } catch {
    sharedCtx = null;
    return null;
  }
};

/** 等 resume 真正完成再排程；suspended 时调度的音符不会发声。 */
const ensureRunning = (ctx: AudioContext): Promise<void> => {
  if (ctx.state === 'running') return Promise.resolve();
  try {
    const resumed = ctx.resume?.();
    if (resumed && typeof resumed.then === 'function') {
      return resumed.then(() => undefined).catch(() => undefined);
    }
  } catch {
    // resume 抛错时按"尽力而为"处理，仍然尝试发声
  }
  return Promise.resolve();
};

/**
 * 首次用户手势时解锁音频。
 * 浏览器只允许在用户交互后启动 AudioContext；宿主推送的提示音发生在
 * 非手势上下文中，必须先有一个被解锁过的上下文才能真正出声。
 */
const installAudioUnlock = (): void => {
  if (typeof window === 'undefined') return;
  const unlock = (): void => {
    const ctx = acquireContext();
    if (ctx) void ensureRunning(ctx);
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
};
installAudioUnlock();

/** 播放入口：variant='error' 播警示双音；custom 用宿主下发的 base64 数据。 */
export function playNotificationSound(payload: { soundId?: string; variant?: string; customDataBase64?: string }): void {
  try {
    const ctx = acquireContext();
    if (!ctx) return;
    const soundId = payload.soundId ?? 'default';

    // 错误音 / 内置预设：resume 完成后合成。
    if (payload.variant === 'error' || soundId !== 'custom') {
      const stateBefore = ctx.state;
      void ensureRunning(ctx).then(() => {
        console.error(
          `[Sound] play soundId=${soundId} variant=${payload.variant ?? '-'}`
          + ` stateBefore=${stateBefore} stateAfter=${ctx.state}`,
        );
        if (ctx.state === 'closed') return;
        try {
          synthesize(ctx, soundId, payload.variant);
        } catch {
          // 合成失败静默
        }
      });
      return;
    }

    const data = payload.customDataBase64;
    if (!data) {
      void ensureRunning(ctx).then(() => {
        if (ctx.state !== 'closed') synthesize(ctx, 'default');
      });
      return;
    }

    void ctx
      .decodeAudioData(base64ToArrayBuffer(data))
      .then((buffer) => ensureRunning(ctx).then(() => buffer))
      .then((buffer) => {
        if (ctx.state === 'closed') return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
      })
      .catch(() => {
        // 解码失败回退默认音
        if (ctx.state !== 'closed') synthesize(ctx, 'default');
      });
  } catch {
    // Audio unavailable — ignore
  }
}
