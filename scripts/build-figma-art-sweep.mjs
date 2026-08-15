/**
 * Trace the demo mark at each stop of the plugin's colours slider, and record
 * what each one cost.
 *
 * This is the data behind the carousel slide that shows the slider. Every
 * number under every swatch is a real verify pass on that exact setting, so a
 * user can read the slide as a prediction of what they will get rather than as
 * decoration. Nothing here is interpolated between measured points.
 *
 *   node scripts/build-figma-art-sweep.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'extensions', 'figma', 'art');

const { vectorize, loadRaster } = await import('../dist/esm/index.js');
const source = await loadRaster(readFileSync(join(ART, 'mark-demo.png')));

/* Four stops spanning the slider's 2..64 range, at the powers of two a user is
   most likely to land on. 16 is the shipped default and is marked as such. */
const STOPS = [4, 8, 16, 32];

const results = [];
for (const colors of STOPS) {
  const result = await vectorize(source, {
    mode: 'trace',
    trace: { colors, gradients: true },
    verify: true,
  });
  const svg = result.svg;
  const q = result.quality ?? {};
  if (typeof q.ssim !== 'number') {
    console.error(`verify returned no ssim at ${colors} colours`);
    process.exit(1);
  }
  writeFileSync(join(ART, `sweep-${colors}.svg`), svg);
  results.push({
    colors,
    ssim: q.ssim,
    psnr: q.psnr,
    paths: (svg.match(/<(path|rect|circle|ellipse|polygon)\b/g) ?? []).length,
    kb: +(Buffer.byteLength(svg) / 1024).toFixed(1),
    isDefault: colors === 16,
  });
}

writeFileSync(join(ART, 'sweep.json'), JSON.stringify(results, null, 2) + '\n');
console.table(results);
