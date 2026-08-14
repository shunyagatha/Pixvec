/**
 * Feature benchmarks — measured, not asserted.
 *
 * Prints a small Markdown table quantifying two of vecline's differentiators on
 * synthetic-but-honest inputs: radial-gradient de-banding (a vignette) and
 * geometric-primitive recognition (a disc). Every number here is produced by
 * rendering the actual SVG output back to pixels and scoring it — run
 * `npm run bench:features` to reproduce.
 */

import { trace } from '../dist/esm/vectorize/trace.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { compareImages } from '../dist/esm/metrics/index.js';

function vignette(s) {
  const d = new Uint8ClampedArray(s * s * 4);
  const c = (s - 1) / 2;
  const rMax = Math.hypot(c, c);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t = Math.min(1, Math.hypot(x - c, y - c) / rMax);
      const o = (y * s + x) * 4;
      d[o] = Math.round(250 - 210 * t);
      d[o + 1] = Math.round(240 - 200 * t);
      d[o + 2] = Math.round(255 - 120 * t);
      d[o + 3] = 255;
    }
  }
  return { width: s, height: s, data: d };
}

function disc(s) {
  const d = new Uint8ClampedArray(s * s * 4);
  const c = s / 2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const inside = Math.hypot(x + 0.5 - c, y + 0.5 - c) <= s * 0.34;
      const o = (y * s + x) * 4;
      d[o] = inside ? 230 : 255;
      d[o + 1] = inside ? 40 : 255;
      d[o + 2] = inside ? 60 : 255;
      d[o + 3] = 255;
    }
  }
  return { width: s, height: s, data: d };
}

async function score(img, svg) {
  const r = await rasterizeSvg(svg, { width: img.width });
  return compareImages(img, r.image).ssim;
}

const fmtB = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

async function main() {
  const rows = [];

  // --- Radial gradient: flat bands vs one <radialGradient>, per palette size. ---
  const vig = vignette(96);
  for (const colors of [8, 12, 16]) {
    const flat = trace(vig, { colors });
    const grad = trace(vig, { colors, gradients: true });
    rows.push([
      `radial gradient · vignette · ${colors} colours`,
      `${(await score(vig, flat.svg)).toFixed(4)} / ${fmtB(flat.svg.length)}`,
      `${(await score(vig, grad.svg)).toFixed(4)} / ${fmtB(grad.svg.length)}`,
    ]);
  }

  // --- Primitives: Bézier outline vs a true <circle>. ---
  const dsc = disc(120);
  const path = trace(dsc, { colors: 2 });
  const prim = trace(dsc, { colors: 2, primitives: true });
  rows.push([
    'primitive · disc → <circle>',
    `${(await score(dsc, path.svg)).toFixed(4)} / ${fmtB(path.svg.length)}`,
    `${(await score(dsc, prim.svg)).toFixed(4)} / ${fmtB(prim.svg.length)}`,
  ]);

  console.log('| Case | Baseline (SSIM / size) | vecline feature (SSIM / size) |');
  console.log('|---|---|---|');
  for (const [c, base, feat] of rows) console.log(`| ${c} | ${base} | ${feat} |`);
}

main();
