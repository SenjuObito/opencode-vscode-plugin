#!/usr/bin/env node
// Generate a 128x128 black-on-transparent PNG that mirrors the original
// opencode.svg logo (outer rounded-stroke frame + inner solid block) and
// write it to media/opencode.png.
//
// Why a hand-rolled PNG generator? This repo is pure JS and the sandbox where
// the icon was authored has no rsvg-convert / sharp / PIL / qlmanage. Node's
// built-in zlib is enough to emit a valid RGBA PNG that vsce / VS Code
// accept. To re-render from a vector source later (e.g. after redesign),
// install librsvg (`brew install librsvg`) and run:
//   rsvg-convert -w 128 -h 128 media/opencode.svg -o media/opencode.png
//   (or replace this script entirely with that one-liner)
//
// Layout (matches viewBox 0 0 24 24 of the original SVG, scaled to 128x128):
//   outer: rect (4,2) -> (20,22)      -> pixel (21,11) -> (107,117),   stroke ~3px
//   inner: rect (8,6) -> (16,18)      -> pixel (43,32) -> (85,96),     solid fill
//   corners of the outer rect are rounded (~1px in viewBox -> ~5px in pixel)

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 128, H = 128;

function rgba(r, g, b, a) { return [r, g, b, a]; }
const BLACK = rgba(0x1a, 0x1a, 0x1a, 0xff);
const TRANSPARENT = rgba(0, 0, 0, 0);

function setPx(buf, x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // alpha-over composite
  const a = c[3] / 255;
  buf[i]     = Math.round(c[0] * a + buf[i]     * (1 - a));
  buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
  buf[i + 3] = Math.max(buf[i + 3], c[3]);
}

function fillRect(buf, x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(buf, x, y, color);
}

function strokeRect(buf, x0, y0, x1, y1, color, thickness) {
  fillRect(buf, x0, y0, x1, y0 + thickness - 1, color);
  fillRect(buf, x0, y1 - thickness + 1, x1, y1, color);
  fillRect(buf, x0, y0, x0 + thickness - 1, y1, color);
  fillRect(buf, x1 - thickness + 1, y0, x1, y1, color);
}

// Rounded-corner approximation: clip the four corners with quarter-circles.
function roundedStrokeRect(buf, x0, y0, x1, y1, color, thickness, radius) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // find the closest corner and the distance to it
      const cx = x < (x0 + x1) / 2 ? x0 + radius : x1 - radius;
      const cy = y < (y0 + y1) / 2 ? y0 + radius : y1 - radius;
      const insideOuter =
        x >= x0 && x <= x1 && y >= y0 && y <= y1 &&
        !(x < cx - radius || x > cx + radius || y < cy - radius || y > cy + radius);
      const onCornerCut = (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
      if (insideOuter || onCornerCut) continue;
      setPx(buf, x, y, color);
    }
  }
  // overlay the simple stroke (corners will be slightly off — clipped above is
  // good enough for an icon at 128x128, but for crispness we overwrite the
  // straight edges with the exact stroke thickness:
  for (let t = 0; t < thickness; t++) {
    fillRect(buf, x0 + t, y0 + t, x1 - t, y0 + t, color);
    fillRect(buf, x0 + t, y1 - t, x1 - t, y1 - t, color);
    fillRect(buf, x0 + t, y0 + t, x0 + t, y1 - t, color);
    fillRect(buf, x1 - t, y0 + t, x1 - t, y1 - t, color);
  }
}

const buf = Buffer.alloc(W * H * 4, 0); // RGBA, fully transparent

// outer frame: outer rect viewBox(4,2)->(20,22) -> px(21,11)->(107,117)
roundedStrokeRect(buf, 21, 11, 107, 117, BLACK, 3, 4);

// inner solid block: viewBox(8,6)->(16,18) -> px(43,32)->(85,96)
fillRect(buf, 43, 32, 85, 96, BLACK);

// PNG encode
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  const table = []; for (let n = 0; n < 256; n++) {
    let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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

const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
const out = process.argv[2] || 'media/opencode.png';
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes, ${W}x${H} RGBA)`);
