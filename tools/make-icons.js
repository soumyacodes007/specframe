// Draws the Specframe toolbar icons (16/32/48/128 px PNG) with no dependencies.
// Usage: node tools/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const BLUE = [13, 153, 255];
const WHITE = [255, 255, 255];

// Shapes in unit coordinates (0..1), so every size is drawn from the same design
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function shade(x, y, size) {
  // Layer 1: blue rounded tile
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  const stroke = Math.max(0.085, 1.4 / size); // keeps the frame at least ~1.4px wide when small
  const a = 0.24, b = 0.76;                  // the frame
  const onFrame = inRoundRect(x, y, a, a, b, b, 0.06) && !inRoundRect(x, y, a + stroke, a + stroke, b - stroke, b - stroke, 0.02);
  if (onFrame) return { c: WHITE, a: 1 };
  // Layer 2: faint 2×2 grid inside the frame, plus a solid corner cell
  const inFrame = x > a && x < b && y > a && y < b;
  if (inFrame) {
    if (x < 0.5 && y < 0.5) return { c: WHITE, a: 0.5 };
    const line = Math.max(0.035, 0.9 / size);
    if (Math.abs(x - 0.5) < line / 2 || Math.abs(y - 0.5) < line / 2) return { c: WHITE, a: 0.55 };
  }
  return { c: BLUE, a: 1, base: true };
}

function render(size) {
  const ss = 4, px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, bl = 0, al = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const s = shade((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size, size);
          if (!s) continue;
          // composite over the blue tile
          const c = s.base ? BLUE : s.c.map((v, k) => v * s.a + BLUE[k] * (1 - s.a));
          r += c[0]; g += c[1]; bl += c[2]; al += 1;
        }
      }
      const n = ss * ss, o = (j * size + i) * 4;
      // un-premultiply colour by covered samples, alpha = coverage
      px[o] = al ? Math.round(r / al) : 0;
      px[o + 1] = al ? Math.round(g / al) : 0;
      px[o + 2] = al ? Math.round(bl / al) : 0;
      px[o + 3] = Math.round((al / n) * 255);
    }
  }
  return png(size, size, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), render(size));
  console.log(`icons/icon${size}.png`);
}
