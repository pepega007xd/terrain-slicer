// Generates sample heightmap files in samples/:
//   terrain8.png   (8-bit grayscale PNG)
//   terrain16.png  (16-bit grayscale PNG)
//   terrain.exr    (single-channel half-float EXR, uncompressed)
import { encode } from 'fast-png';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateSampleHeights } from '../src/sampleTerrain.js';

const n = 256;
const { values } = generateSampleHeights(n);
mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });

// 8-bit PNG
const u8 = new Uint8Array(n * n);
for (let i = 0; i < values.length; i++) u8[i] = Math.round(values[i] * 255);
writeFileSync(new URL('../samples/terrain8.png', import.meta.url),
  encode({ width: n, height: n, depth: 8, channels: 1, data: u8 }));

// 16-bit PNG
const u16 = new Uint16Array(n * n);
for (let i = 0; i < values.length; i++) u16[i] = Math.round(values[i] * 65535);
writeFileSync(new URL('../samples/terrain16.png', import.meta.url),
  encode({ width: n, height: n, depth: 16, channels: 1, data: u16 }));

// EXR (half float, compression NONE, single channel "R")
writeEXR(new URL('../samples/terrain.exr', import.meta.url), n, n, values);

function f32ToHalf(val) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const expBits = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (expBits === 255) return sign | 0x7c00 | (man ? 1 : 0);
  const exp = expBits - 112; // bias diff: 127 - 15
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    man = (man | 0x800000) >>> (1 - exp);
    return sign | ((man + 0x1000) >>> 13);
  }
  return sign | (exp << 10) | ((man + 0x1000) >>> 13);
}

function writeEXR(url, w, h, values) {
  const parts = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
  const str = (s) => Buffer.from(s, 'latin1');

  function attr(name, type, data) {
    parts.push(str(name + '\0'), str(type + '\0'), i32(data.length), data);
  }

  // channel list: name, pixelType (1 = HALF), pLinear + 3 reserved, xSampling, ySampling
  // "Y" = luminance, the conventional name for single-channel height EXRs
  const chlist = Buffer.concat([
    str('Y\0'), i32(1), Buffer.from([0, 0, 0, 0]), i32(1), i32(1), str('\0'),
  ]);

  parts.push(str('v/1\x01')); // magic
  parts.push(i32(2));          // version 2, scanline single-part

  attr('channels', 'chlist', chlist);
  attr('compression', 'compression', Buffer.from([0])); // NONE
  attr('dataWindow', 'box2i', Buffer.concat([i32(0), i32(0), i32(w - 1), i32(h - 1)]));
  attr('displayWindow', 'box2i', Buffer.concat([i32(0), i32(0), i32(w - 1), i32(h - 1)]));
  attr('lineOrder', 'lineOrder', Buffer.from([0])); // INCREASING_Y
  attr('pixelAspectRatio', 'float', f32(1));
  attr('screenWindowCenter', 'v2f', Buffer.concat([f32(0), f32(0)]));
  attr('screenWindowWidth', 'float', f32(w));
  parts.push(str('\0')); // header terminator

  const headerSize = parts.reduce((a, b) => a + b.length, 0);
  const blockSize = 8 + w * 2;
  for (let y = 0; y < h; y++) parts.push(u64(headerSize + y * blockSize));

  for (let y = 0; y < h; y++) {
    const row = h - 1 - y; // EXR y=0 is the bottom row
    parts.push(i32(y), i32(w * 2));
    const halfRow = Buffer.alloc(w * 2);
    for (let x = 0; x < w; x++) halfRow.writeUInt16LE(f32ToHalf(values[row * w + x]), x * 2);
    parts.push(halfRow);
  }
  writeFileSync(url, Buffer.concat(parts));
}

console.log('samples written');
