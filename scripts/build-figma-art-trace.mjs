/**
 * Produce the traces the Figma thumbnail is built from, and record what they
 * measured.
 *
 * Split out from build-figma-art.mjs so the numbers on the thumbnail come from
 * a real verify pass rather than from constants somebody typed. Options are the
 * plugin's own control defaults — trace mode, 16 colours, gradients checked —
 * so the panel shows what a user gets on first run, not a tuned exhibition run.
 *
 * Two traces, differing only in `gradients`. The thumbnail puts them either
 * side of a split because it is the one difference that is both visible at
 * thumbnail size and measurably in our favour on every axis at once.
 *
 *   node scripts/build-figma-art-trace.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'extensions', 'figma', 'art');

const { vectorize, loadRaster } = await import('../dist/esm/index.js');
const source = await loadRaster(readFileSync(join(ART, 'mark-demo.png')));

/** From extensions/figma/src/ui.html: colours slider ships at 16. */
const COLORS = 16;

async function run(gradients) {
  const started = Date.now();
  const result = await vectorize(source, {
    mode: 'trace',
    trace: { colors: COLORS, gradients },
    verify: true,
  });
  const ms = Date.now() - started;
  const svg = result.svg;
  const q = result.quality ?? {};

  if (typeof q.ssim !== 'number' || typeof q.psnr !== 'number') {
    console.error('verify returned no ssim/psnr; got:', Object.keys(q));
    process.exit(1);
  }

  writeFileSync(join(ART, `grad-${gradients ? 'on' : 'off'}.svg`), svg);
  return {
    ssim: q.ssim,
    psnr: q.psnr,
    shapes: (svg.match(/<(path|rect|circle|ellipse|polygon)\b/g) ?? []).length,
    kb: +(Buffer.byteLength(svg) / 1024).toFixed(1),
    ms,
  };
}

const off = await run(false);
const on = await run(true);

/* The claim the thumbnail makes is that gradients on is better on every axis.
   Assert it here rather than trusting it, so a regression fails the build
   instead of quietly shipping a thumbnail that argues against itself. */
const wins = on.ssim > off.ssim && on.psnr > off.psnr && on.shapes < off.shapes && on.kb < off.kb;
if (!wins) {
  console.error('gradients no longer win on every axis — the thumbnail copy would be wrong:');
  console.error({ off, on });
  process.exit(1);
}

writeFileSync(join(ART, 'metrics.json'), JSON.stringify({ off, on }, null, 2) + '\n');
console.log({ off, on });
