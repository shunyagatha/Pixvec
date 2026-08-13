#!/usr/bin/env node
/**
 * Reproduce the accuracy table in the README.
 *
 * Every figure the project publishes should be regenerable by anyone who clones
 * it. Fixtures are synthesised here rather than downloaded, so the numbers do
 * not depend on assets that might move, change, or carry an unclear licence.
 *
 *   npm run bench            # markdown table
 *   npm run bench -- --json  # machine-readable
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadRaster, vectorize } from '../dist/api.js';

const asJson = process.argv.includes('--json');

function image(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function setPixel(img, x, y, r, g, b, a = 255) {
  const o = (y * img.width + x) * 4;
  img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flatArtwork(width, height) {
  const img = image(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2);
      if (d < height / 5) setPixel(img, x, y, 250, 244, 232);
      else if (d < height / 2.7) setPixel(img, x, y, 214, 69, 65);
      else if (x < width / 3) setPixel(img, x, y, 32, 96, 160);
      else if (x < (2 * width) / 3) setPixel(img, x, y, 250, 244, 232);
      else setPixel(img, x, y, 40, 150, 110);
    }
  }
  return img;
}

function pixelArt(scale) {
  const rows = [
    '..GGGG..', '.GRRRRG.', 'GRWRRWRG', 'GRRRRRRG',
    'GRWRRWRG', 'GRRWWRRG', '.GRRRRG.', '..GGGG..',
  ];
  const palette = {
    '.': [0, 0, 0, 0], G: [24, 32, 48, 255], R: [222, 88, 72, 255], W: [255, 255, 255, 255],
  };
  const img = image(8 * scale, 8 * scale);
  for (let y = 0; y < 8 * scale; y++) {
    for (let x = 0; x < 8 * scale; x++) {
      const c = palette[rows[Math.floor(y / scale)][Math.floor(x / scale)]];
      setPixel(img, x, y, c[0], c[1], c[2], c[3]);
    }
  }
  return img;
}

function photoLike(width, height, seed = 11) {
  const img = image(width, height);
  const rand = mulberry32(seed);
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1), v = y / (height - 1);
      setPixel(img, x, y,
        clamp(40 + 180 * u + 40 * Math.sin(v * 9) + rand() * 8),
        clamp(30 + 150 * v + 50 * Math.cos(u * 7) + rand() * 8),
        clamp(200 - 120 * u * v + rand() * 8));
    }
  }
  return img;
}

async function encode(img, format) {
  const p = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  });
  return format === 'jpeg' ? p.jpeg({ quality: 95 }).toBuffer() : p.png({ compressionLevel: 9 }).toBuffer();
}

const dir = await mkdtemp(join(tmpdir(), 'pixvec-bench-'));
const results = [];

try {
  const cases = [
    { label: 'Flat artwork, 400×300', img: flatArtwork(400, 300), format: 'png', opts: {} },
    { label: 'Pixel art sprite, 128×128', img: pixelArt(16), format: 'png', opts: {} },
    { label: 'Flat artwork, 400×300', img: flatArtwork(400, 300), format: 'png', opts: { mode: 'embed' }, note: 'embed' },
    { label: 'Photo, 320×240', img: photoLike(320, 240), format: 'jpeg', opts: { mode: 'embed' }, note: 'embed' },
    { label: 'Photo, 320×240', img: photoLike(320, 240), format: 'jpeg', opts: {}, note: 'trace auto' },
    { label: 'Photo, 320×240', img: photoLike(320, 240), format: 'jpeg', opts: { preset: 'photo' }, note: 'trace --preset photo' },
  ];

  for (const [i, c] of cases.entries()) {
    const bytes = await encode(c.img, c.format);
    const path = join(dir, `case-${i}.${c.format === 'jpeg' ? 'jpg' : 'png'}`);
    await writeFile(path, bytes);

    const source = await loadRaster(bytes);
    const started = Date.now();
    const result = await vectorize(source, { verify: true, ...c.opts });
    const elapsed = Date.now() - started;

    results.push({
      input: c.label,
      mode: c.note ?? result.mode,
      resolvedMode: result.mode,
      inputBytes: bytes.length,
      outputBytes: Buffer.byteLength(result.svg),
      exactRatio: result.quality.exactRatio,
      psnr: result.quality.psnr,
      ssim: result.quality.ssim,
      deltaEMean: result.quality.deltaE.mean,
      lossless: result.lossless,
      shapes: result.shapes,
      elapsedMs: elapsed,
    });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(results, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v, 2));
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log('| Input | Mode | In | Out | Pixels exact | PSNR | SSIM | Mean ΔE₀₀ |');
  console.log('|---|---|--:|--:|--:|--:|--:|--:|');
  for (const r of results) {
    console.log(
      `| ${r.input} | \`${r.mode}\` | ${kb(r.inputBytes)} | ${kb(r.outputBytes)} | ` +
      `${(r.exactRatio * 100).toFixed(2)}% | ${Number.isFinite(r.psnr) ? `${r.psnr.toFixed(2)} dB` : '∞'} | ` +
      `${r.ssim.toFixed(4)} | ${r.deltaEMean.toFixed(3)} |`,
    );
  }
}
