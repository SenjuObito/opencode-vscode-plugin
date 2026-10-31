import { describe, expect, it } from 'vitest';
import { BUILTIN_SOUND_ASSETS, dataUrlToArrayBuffer } from './notificationSound';

describe('notificationSound assets', () => {
  it('maps every built-in sound id to a bundled asset', () => {
    expect(Object.keys(BUILTIN_SOUND_ASSETS).sort()).toEqual([
      'bell',
      'chime',
      'default',
      'ding',
      'success',
    ]);
    for (const url of Object.values(BUILTIN_SOUND_ASSETS)) {
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    }
  });

  it('decodes a base64 data url into the original bytes', () => {
    const payload = 'RIFFfake-wave-bytes';
    const dataUrl = `data:audio/wav;base64,${btoa(payload)}`;

    const buffer = dataUrlToArrayBuffer(dataUrl);

    expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(new TextEncoder().encode(payload)));
  });

  it('accepts raw base64 without the data url prefix', () => {
    const payload = 'raw-base64';
    const buffer = dataUrlToArrayBuffer(btoa(payload));

    expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(new TextEncoder().encode(payload)));
  });
});
