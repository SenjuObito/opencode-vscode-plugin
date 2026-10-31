/**
 * notificationSound —— 通知提示音播放（内置 WAV 资源 + 自定义文件解码）。
 *
 * 由宿主 `playNotificationSound` 推送触发（见 src/host/notifications/
 * NotificationService.ts），判定逻辑在宿主，这里只负责发声：
 *   - 5 个内置预设音：default / chime / bell / ding / success
 *     （与 IDEA 插件共用同一批 WAV 资源，见 src/main/resources/sounds）
 *   - error 变体：固定低沉双音（不随用户 selectedSound 设置变化）
 *   - custom：宿主下发的 base64 音频数据经 decodeAudioData 播放，
 *     解码失败回退 default
 */

// 与 IDEA `SoundNotificationService.SOUND_RESOURCES` 一一对应：
// default -> success.wav，success -> task-complete.wav。
// Vite 的 assetsInlineLimit 为 1MB，构建时会被内联成 data URL，
// 单文件 webview 打包产物不需要额外静态资源。
import defaultSoundAsset from '../assets/sounds/success.wav';
import chimeSoundAsset from '../assets/sounds/chime.wav';
import bellSoundAsset from '../assets/sounds/bell.wav';
import dingSoundAsset from '../assets/sounds/ding.wav';
import successSoundAsset from '../assets/sounds/task-complete.wav';

type AudioContextCtor = typeof AudioContext;

const getAudioContextCtor = (): AudioContextCtor | null => {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

/** 内置预设音 -> WAV 资源（构建后是 data URL，dev 下是 URL 路径）。 */
export const BUILTIN_SOUND_ASSETS: Readonly<Record<string, string>> = {
  default: defaultSoundAsset,
  chime: chimeSoundAsset,
  bell: bellSoundAsset,
  ding: dingSoundAsset,
  success: successSoundAsset,
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

/** `data:audio/wav;base64,....` -> ArrayBuffer（CSP 不允许 fetch(data:)，只能本地解码）。 */
export const dataUrlToArrayBuffer = (dataUrl: string): ArrayBuffer => {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return base64ToArrayBuffer(base64);
};

/**
 * 主增益 + 限幅链。
 *
 * IDEA 插件播放提示音时把 MASTER_GAIN / VOLUME 都推到最大
 * （见 SoundNotificationService#playAudioStream），实际输出接近满刻度。
 * 这里用等价的"轻微放大 + 近满刻度限幅"复刻：峰值贴着 0 dBFS，
 * 但限幅器保证连续点击叠加时不会削波破音。
 */
const MASTER_GAIN = 1.25;

interface MasterChain {
  ctx: AudioContext;
  input: GainNode;
}

let masterChain: MasterChain | null = null;

const getMasterInput = (ctx: AudioContext): AudioNode => {
  if (masterChain && masterChain.ctx === ctx) {
    return masterChain.input;
  }
  const gain = ctx.createGain();
  gain.gain.value = MASTER_GAIN;
  const limiter = ctx.createDynamicsCompressor();
  // 阈值 -1dB：只压住接近满刻度的峰值，不再整体压低音量。
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  gain.connect(limiter);
  limiter.connect(ctx.destination);
  masterChain = { ctx, input: gain };
  return gain;
};

/**
 * 合成兜底音；仅用于 error 变体与 WAV 解码失败时的回退。
 * error 为固定低沉双音。
 */
const synthesize = (ctx: AudioContext, soundId: string, variant?: string): void => {
  const now = ctx.currentTime;
  const output = getMasterInput(ctx);
  const tone = (freq: number, start: number, duration: number, gainValue = 0.18, type: OscillatorType = 'sine') => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(gainValue, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(gain);
    gain.connect(output);
    osc.start(now + start);
    osc.stop(now + start + duration);
  };

  if (variant === 'error') {
    // 低沉双音：A3 → E3，与普通提示音明显区分
    tone(220, 0, 0.22, 0.8, 'triangle');
    tone(164.81, 0.18, 0.35, 0.8, 'triangle');
    return;
  }

  switch (soundId) {
    case 'chime':
      tone(523.25, 0, 0.25, 0.6);
      tone(659.25, 0.12, 0.25, 0.6);
      tone(783.99, 0.24, 0.35, 0.6);
      break;
    case 'bell':
      tone(880, 0, 0.3, 0.6);
      tone(1320, 0, 0.3, 0.3);
      break;
    case 'ding':
      tone(1200, 0, 0.15, 0.7);
      break;
    case 'success':
      tone(523.25, 0, 0.12, 0.5);
      tone(659.25, 0.1, 0.12, 0.5);
      tone(783.99, 0.2, 0.12, 0.5);
      tone(1046.5, 0.3, 0.3, 0.5);
      break;
    case 'default':
    default:
      tone(800, 0, 0.2, 0.6);
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

/** 解码结果按 soundId 缓存，重复点击试听不再重复 decode。 */
const decodedCache = new Map<string, Promise<AudioBuffer>>();

const acquireContext = (): AudioContext | null => {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    if (!sharedCtx || sharedCtx.state === 'closed') {
      sharedCtx = new Ctor();
      decodedCache.clear();
      masterChain = null;
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

const loadAssetArrayBuffer = async (url: string): Promise<ArrayBuffer> => {
  // 生产构建下是 data URL；dev server 下是 /src/assets/... 路径。
  if (url.startsWith('data:')) {
    return dataUrlToArrayBuffer(url);
  }
  const response = await fetch(url);
  return response.arrayBuffer();
};

const decodePreset = (ctx: AudioContext, soundId: string): Promise<AudioBuffer> => {
  const cached = decodedCache.get(soundId);
  if (cached) return cached;

  const pending = loadAssetArrayBuffer(BUILTIN_SOUND_ASSETS[soundId] ?? BUILTIN_SOUND_ASSETS.default)
    .then((data) => {
      // decodeAudioData 会接管并 detach 传入的 buffer，因此每次都传新副本。
      return ctx.decodeAudioData(data.slice(0));
    });

  decodedCache.set(soundId, pending);
  // 解码失败要清掉缓存，否则后续重试永远命中 rejected promise。
  pending.catch(() => decodedCache.delete(soundId));
  return pending;
};

const playBuffer = (ctx: AudioContext, buffer: AudioBuffer): void => {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(getMasterInput(ctx));
  source.start();
};

/** 排障日志：生产环境只有 console.error 会被保留（见 main.tsx）。 */
const logPlay = (ctx: AudioContext, soundId: string, variant: string | undefined, stateBefore: AudioContextState): void => {
  console.error(
    `[Sound] play soundId=${soundId} variant=${variant ?? '-'}`
    + ` stateBefore=${stateBefore} stateAfter=${ctx.state}`,
  );
};

/** 播放内置预设音；任何一步失败都回退到合成音，保证不会静默。 */
const playPreset = (ctx: AudioContext, soundId: string): void => {
  const resolvedId = BUILTIN_SOUND_ASSETS[soundId] ? soundId : 'default';
  const stateBefore = ctx.state;
  void ensureRunning(ctx)
    .then(() => {
      logPlay(ctx, resolvedId, undefined, stateBefore);
      if (ctx.state === 'closed') return undefined;
      return decodePreset(ctx, resolvedId);
    })
    .then((buffer) => {
      if (!buffer || ctx.state === 'closed') return;
      playBuffer(ctx, buffer);
    })
    .catch(() => {
      if (ctx.state !== 'closed') synthesize(ctx, resolvedId);
    });
};

/** 自定义文件：宿主已经把文件读成 base64。 */
const playCustom = (ctx: AudioContext, data: string | undefined): void => {
  if (!data) {
    playPreset(ctx, 'default');
    return;
  }
  void ctx
    .decodeAudioData(base64ToArrayBuffer(data))
    .then((buffer) => ensureRunning(ctx).then(() => buffer))
    .then((buffer) => {
      if (ctx.state === 'closed') return;
      playBuffer(ctx, buffer);
    })
    .catch(() => {
      // 解码失败回退默认音
      if (ctx.state !== 'closed') playPreset(ctx, 'default');
    });
};

/** 播放入口：variant='error' 播警示双音；custom 用宿主下发的 base64 数据。 */
export function playNotificationSound(payload: { soundId?: string; variant?: string; customDataBase64?: string }): void {
  try {
    const ctx = acquireContext();
    if (!ctx) return;
    const soundId = payload.soundId ?? 'default';

    // 错误音：固定低沉双音，resume 完成后合成。
    if (payload.variant === 'error') {
      const stateBefore = ctx.state;
      void ensureRunning(ctx).then(() => {
        logPlay(ctx, soundId, payload.variant, stateBefore);
        if (ctx.state === 'closed') return;
        try {
          synthesize(ctx, soundId, payload.variant);
        } catch {
          // 合成失败静默
        }
      });
      return;
    }

    if (soundId === 'custom') {
      playCustom(ctx, payload.customDataBase64);
      return;
    }

    playPreset(ctx, soundId);
  } catch {
    // Audio unavailable — ignore
  }
}
