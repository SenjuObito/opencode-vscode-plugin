#!/usr/bin/env node
// media/opencode.png is the VS Code marketplace icon. It is normally synced
// from the upstream opencode repo — the canonical source lives at:
//
//   packages/ui/src/assets/favicon/web-app-manifest-512x512.png
// (in a clone of github.com/sst/opencode, e.g. /Users/obito/source/repos/opencode)
//
// To refresh after an upstream icon change:
//   cp /Users/obito/source/repos/opencode/packages/ui/src/assets/favicon/web-app-manifest-512x512.png \
//      media/opencode.png
//
// The PNG is 512x512 RGBA with an opaque black background — that's by design
// from upstream and is what shows up in the Marketplace and the VS Code
// extension list.
//
// This script is kept only as a fallback generator for cases where the
// upstream asset is unavailable. It re-creates an approximation of the
// older design (the "回" frame) from media/opencode-activity-dark.svg,
// viewBox 0 0 24 24, scaled to 128x128, ink colour #1A1A1A on transparent.
//
// To re-render the upstream vector source instead, install librsvg
// (`brew install librsvg`) and run:
//   rsvg-convert -w 128 -h 128 /Users/obito/source/repos/opencode/packages/ui/src/assets/favicon/favicon-v3.svg \
//     -o media/opencode.png

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 128, H = 128;
const VB = 24;                 // source viewBox is 0 0 24 24
const SCALE = W / VB;          // 1 viewBox unit ≈ 5.333 px

const INK = [0x1A, 0x1A, 0x1A, 0xFF];

// Rectangles in viewBox coordinates, matching the two path subpaths.
const OUTER = { x0: 4, y0: 2, x1: 20, y1: 22 };
const INNER = { x0: 8, y0: 6, x1: 16, y1: 18 };

const inRect = (vx, vy, r) => vx >= r.x0 && vx <= r.x1 && vy >= r.y0 && vy <= r.y1;

function setPx(buf, x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = c[3] / 255;
  buf[i]     = Math.round(c[0] * a + buf[i]     * (1 - a));
  buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
  buf[i + 3] = Math.max(buf[i + 3], c[3]);
}

const buf = Buffer.alloc(W * H * 4, 0); // RGBA, fully transparent

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Sample the pixel centre, mapped back into viewBox space.
    const vx = (x + 0.5) / SCALE;
    const vy = (y + 0.5) / SCALE;
    const inOuter = inRect(vx, vy, OUTER);
    const inInner = inRect(vx, vy, INNER);
    // fill-rule="evenodd" -> fill where the two subpaths differ (XOR).
    if (inOuter !== inInner) setPx(buf, x, y, INK);
  }
}

// ---- PNG encode -----------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (const b of Buffer.concat([typeBuf, data])) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

// filter byte 0 per scanline + RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[2] || 'media/opencode.png';
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes, ${W}x${H} RGBA, #1A1A1A on transparent)`);