#!/usr/bin/env node
/**
 * Head-to-head against other vectorizers.
 *
 * The point of this script is that it can embarrass us. Every tool is measured
 * the same way: its SVG is rendered with the *same* renderer and scored with the
 * *same* metrics, so nothing here depends on Pixvec's own view of quality.
 *
 * Compared:
 *   potrace         the reference bilevel tracer, via its JavaScript port
 *   potrace/posterize  its multi-level mode, the closest thing it has to colour
 *   imagetracerjs   a widely used colour tracer
 *   pixvec          this package
 *
 * potrace is bilevel by design, so it is scored on a black-and-white fixture
 * where the comparison is apples to apples, and posterize is used for colour.
 * Reporting potrace's colour score without that caveat would be a rigged fight.
 *
 *   npm run compare
 *   npm run compare -- --json
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import potrace from 'potrace';
import imagetracer from 'imagetracerjs';
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { compareImages } from '../dist/esm/metrics/index.js';

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

/** Black-and-white artwork: the case potrace was designed for. */
function bilevelArt(w, h) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2);
      const ring = d < h * 0.18 || (d > h * 0.28 && d < h * 0.42);
      const bar = Math.abs(y - h / 2) < h * 0.06 && x > w * 0.1 && x < w * 0.9;
      const on = ring || bar;
      setPixel(img, x, y, on ? 0 : 255, on ? 0 : 255, on ? 0 : 255);
    }
  }
  return img;
}

function colourArt(w, h) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2);
      if (d < h * 0.2) setPixel(img, x, y, 250, 244, 232);
      else if (d < h * 0.37) setPixel(img, x, y, 214, 69, 65);
      else if (x < w / 3) setPixel(img, x, y, 32, 96, 160);
      else if (x < (2 * w) / 3) setPixel(img, x, y, 250, 244, 232);
      else setPixel(img, x, y, 40, 150, 110);
    }
  }
  return img;
}

function photoLike(w, h, seed = 11) {
  const img = image(w, h);
  const rand = mulberry32(seed);
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1), v = y / (h - 1);
      setPixel(img, x, y,
        clamp(40 + 180 * u + 40 * Math.sin(v * 9) + rand() * 8),
        clamp(30 + 150 * v + 50 * Math.cos(u * 7) + rand() * 8),
        clamp(200 - 120 * u * v + rand() * 8));
    }
  }
  return img;
}

const toPng = (img) =>
  sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toBuffer();

/** Score any SVG against the source, using one renderer and one metric set. */
async function score(source, svg) {
  // Every tool is rendered on the same white ground. potrace emits shapes on a
  // transparent background, so scoring it against an opaque source without this
  // would report ~2 dB and be a rigged fight rather than a comparison.
  const { image: rendered } = await rasterizeSvg(svg, {
    width: source.width,
    background: { r: 255, g: 255, b: 255, a: 255 },
  });
  if (rendered.width !== source.width || rendered.height !== source.height) {
    return { error: `size mismatch ${rendered.width}x${rendered.height}` };
  }
  const q = compareImages(source, rendered);
  return {
    bytes: Buffer.byteLength(svg),
    psnr: q.psnr,
    ssim: q.ssim,
    deltaE: q.deltaE.mean,
    exact: q.exactRatio,
  };
}

const runPotrace = (file, options) =>
  new Promise((resolve, reject) =>
    potrace.trace(file, options, (err, svg) => (err ? reject(err) : resolve(svg))));

const runPosterize = (file, options) =>
  new Promise((resolve, reject) =>
    potrace.posterize(file, options, (err, svg) => (err ? reject(err) : resolve(svg))));

const dir = await mkdtemp(join(tmpdir(), 'pixvec-compare-'));
const results = [];

async function contend(fixtureName, source, entrants) {
  const file = join(dir, `${fixtureName}.png`);
  await writeFile(file, await toPng(source));

  for (const [tool, produce] of entrants) {
    let row = { fixture: fixtureName, tool };
    try {
      const started = Date.now();
      const svg = await produce(file, source);
      row = { ...row, ...(await score(source, svg)), ms: Date.now() - started };
    } catch (err) {
      row.error = String(err.message ?? err).slice(0, 60);
    }
    results.push(row);
  }
}

const pixvecTrace = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { mode: 'trace' })).svg;
};
const pixvecLossless = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { mode: 'lossless' })).svg;
};
const tracerjs = async (_file, source) =>
  imagetracer.imagedataToSVG(
    { width: source.width, height: source.height, data: Array.from(source.data) },
    { numberofcolors: 16 },
  );

try {
  await contend('bilevel', bilevelArt(160, 120), [
    ['potrace', (file) => runPotrace(file, { threshold: 128 })],
    ['imagetracerjs', tracerjs],
    ['pixvec trace', pixvecTrace],
    ['pixvec lossless', pixvecLossless],
  ]);

  await contend('colour art', colourArt(160, 120), [
    ['potrace posterize', (file) => runPosterize(file, { steps: 4 })],
    ['imagetracerjs', tracerjs],
    ['pixvec trace', pixvecTrace],
    ['pixvec lossless', pixvecLossless],
  ]);

  await contend('photo', photoLike(120, 90), [
    ['potrace posterize', (file) => runPosterize(file, { steps: 4 })],
    ['imagetracerjs', tracerjs],
    ['pixvec trace', pixvecTrace],
    ['pixvec lossless', pixvecLossless],
  ]);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(results, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v, 2));
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  let current = '';
  console.log('| Fixture | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ | Time |');
  console.log('|---|---|--:|--:|--:|--:|--:|');
  for (const r of results) {
    const fixture = r.fixture === current ? '' : r.fixture;
    current = r.fixture;
    if (r.error) {
      console.log(`| ${fixture} | ${r.tool} | — | — | — | — | ${r.error} |`);
      continue;
    }
    console.log(
      `| ${fixture} | ${r.tool} | ${kb(r.bytes)} | ` +
      `${Number.isFinite(r.psnr) ? `${r.psnr.toFixed(2)} dB` : '∞'} | ` +
      `${r.ssim.toFixed(4)} | ${r.deltaE.toFixed(3)} | ${r.ms} ms |`,
    );
  }
}
