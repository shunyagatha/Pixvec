#!/usr/bin/env node
/**
 * Isolate where the photographic SSIM loss actually comes from.
 *
 * Graver trails imagetracerjs on photo SSIM. A prior guess — that potrace's
 * curve-merging pass was the cause — was implemented and measured to do nothing.
 * This script exists so the *next* fix is aimed by measurement, not by a hunch.
 *
 * It decomposes the pipeline (quantise -> segment -> trace -> fit) and scores
 * each stage's contribution independently, all with the same `compareImages`.
 * Read the output as: at which stage does SSIM stop improving no matter how much
 * budget it is given? That stage is the ceiling.
 *
 *   npm run diagnose
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRaster } from '../dist/esm/api.js';
import { trace } from '../dist/esm/vectorize/trace.js';
import { quantize, NearestColor } from '../dist/esm/vectorize/quantize.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { compareImages } from '../dist/esm/metrics/index.js';

const SRC = 'corpus/src';
const photos = readdirSync(SRC).filter((f) => f.startsWith('photo-') && !f.endsWith('.svg'));

const ssim = async (source, svg) => {
  const { image } = await rasterizeSvg(svg, { width: source.width });
  return compareImages(source, image).ssim;
};

/**
 * Upper bound on what a *palette* can preserve: quantise, then paint every pixel
 * its nearest palette colour and score. No segmentation, no curves — this is the
 * loss the colour reduction alone imposes, before any geometry is involved.
 */
async function paletteCeiling(source, colors) {
  const { width, height, data } = source;
  const pal = quantize(source, colors, { refineIterations: 4 });
  const nearest = new NearestColor(pal, width * height);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const idx = nearest.index(data[o], data[o + 1], data[o + 2]);
    out[o] = pal.rgb[idx * 3];
    out[o + 1] = pal.rgb[idx * 3 + 1];
    out[o + 2] = pal.rgb[idx * 3 + 2];
    out[o + 3] = 255;
  }
  return compareImages(source, { width, height, data: out }).ssim;
}

console.log('Diagnosing the photographic SSIM ceiling.\n');
console.log('For each photo, four numbers:');
console.log('  palette@N   = SSIM if pixels were painted their nearest of N palette colours (quantisation ceiling)');
console.log('  polygon@N   = trace at N colours, exact polygons (tolerance 0) — isolates segmentation from curve fitting');
console.log('  trace@N     = trace at N colours, default curve fitting');
console.log('  trace@256   = trace at the maximum palette\n');

for (const file of photos) {
  const source = (await loadRaster(readFileSync(join(SRC, file)))).image;
  const label = file.padEnd(26);

  const [pal64, pal256] = await Promise.all([paletteCeiling(source, 64), paletteCeiling(source, 256)]);
  const poly64 = await ssim(source, trace(source, { colors: 64, tolerance: 0, minArea: 0, polygonOnly: true }).svg);
  const tr64 = await ssim(source, trace(source, { colors: 64, minArea: 0 }).svg);
  const tr256 = await ssim(source, trace(source, { colors: 256, minArea: 0 }).svg);

  console.log(label);
  console.log(`   palette@64  ${pal64.toFixed(4)}     palette@256 ${pal256.toFixed(4)}`);
  console.log(`   polygon@64  ${poly64.toFixed(4)}     trace@64    ${tr64.toFixed(4)}     trace@256   ${tr256.toFixed(4)}`);

  // Attribute the loss. Each gap names a stage.
  const quantLoss = 1 - pal256;
  const segLoss = pal64 - poly64;      // polygons vs the palette ceiling at 64
  const fitLoss = poly64 - tr64;       // curve fitting vs exact polygons
  const colourHeadroom = tr256 - tr64; // does more palette help?
  console.log(
    `   loss: quantisation~${quantLoss.toFixed(4)}  segmentation~${Math.max(0, segLoss).toFixed(4)}  ` +
    `curve-fit~${Math.max(0, fitLoss).toFixed(4)}  colour-headroom~${colourHeadroom.toFixed(4)}\n`,
  );
}

/**
 * A pure smooth gradient is the cleanest test of flat-fill banding: it has no
 * texture, so any SSIM loss is entirely the palette approximating a continuous
 * ramp with flat steps. If gradient output is the answer, this is where it shows.
 */
console.log('--- flat-fill banding on a synthetic smooth gradient ---');
const W = 200, H = 60;
const grad = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = x / (W - 1);
    const o = (y * W + x) * 4;
    grad.data[o] = Math.round(20 + 200 * t);
    grad.data[o + 1] = Math.round(80 + 120 * t);
    grad.data[o + 2] = Math.round(200 - 150 * t);
    grad.data[o + 3] = 255;
  }
}
for (const colors of [8, 16, 32, 64, 128, 256]) {
  const s = await ssim(grad, trace(grad, { colors, minArea: 0 }).svg);
  console.log(`   gradient trace@${String(colors).padStart(3)}  SSIM ${s.toFixed(4)}`);
}
console.log('\nIf gradient SSIM stays well below 1.0 even at 256 colours, flat-fill banding is real');
console.log('and gradient output (Phase 3) is the right lever. If it reaches ~1.0, the photo loss');
console.log('is elsewhere.');
