/**
 * Perceptual image diff — visual regression, measured.
 *
 * Two renders of a page, two exports of a design: what changed, and by how
 * much? This paints a pixelmatch-style heatmap — the base image faded to a pale
 * backdrop, every pixel that moved beyond a **CIEDE2000** threshold flagged in a
 * highlight colour — and returns the counts and the worst/mean ΔE alongside it.
 * Perceptual ΔE, not a raw channel subtraction, so a one-bit rounding wobble
 * does not light up the whole frame while a genuine hue shift goes unnoticed.
 *
 * Pure: two {@link RasterImage}s in, a heatmap image and statistics out. No
 * dependencies, so it runs in `graver/core` in the browser as well as in Node.
 */

import { srgbToLab, deltaE2000, luma709 } from './color.js';
import type { RasterImage, Rgba } from './types.js';

export interface DiffOptions {
  /** CIEDE2000 above which a pixel counts as changed. Default 2 (a just-noticeable difference). */
  threshold?: number;
  /** How much of the base image to keep under the highlights, 0–1. Default 0.1 (faint). */
  baseAlpha?: number;
  /** Highlight colour for changed pixels. Default red. */
  diffColor?: Rgba;
  /** Count an alpha change as a difference too. Default true. */
  includeAlpha?: boolean;
}

export interface DiffResult {
  /** The heatmap: faded base + highlighted changes. */
  image: RasterImage;
  changedPixels: number;
  totalPixels: number;
  /** `changedPixels / totalPixels`. */
  changedFraction: number;
  /** Worst per-pixel CIEDE2000. */
  maxDeltaE: number;
  /** Mean per-pixel CIEDE2000 across the frame. */
  meanDeltaE: number;
}

/** Compare two same-size images and produce a highlighted difference heatmap. */
export function diffImages(a: RasterImage, b: RasterImage, opts: DiffOptions = {}): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `diff needs two images of the same size: got ${a.width}×${a.height} and ${b.width}×${b.height}. ` +
        'Resize one to match first.',
    );
  }
  const threshold = opts.threshold ?? 2;
  const keep = clamp01(opts.baseAlpha ?? 0.1);
  const dc = opts.diffColor ?? { r: 255, g: 40, b: 40, a: 255 };
  const includeAlpha = opts.includeAlpha !== false;

  const { width, height } = a;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const lab1 = new Float64Array(3);
  const lab2 = new Float64Array(3);

  let changed = 0;
  let maxDE = 0;
  let sumDE = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const aa = a.data[o + 3], ba = b.data[o + 3];
    const af = aa / 255, bf = ba / 255;

    // Compare what is actually *seen*: composite each pixel over white before
    // measuring ΔE. Straight RGB under transparency is tool-dependent junk —
    // two fully-transparent pixels of different "colour" render identically and
    // must read as unchanged, not light up the heatmap. (Matches the quality
    // report, which also scores ΔE over a composited background.)
    const car = Math.round(a.data[o] * af + 255 * (1 - af));
    const cag = Math.round(a.data[o + 1] * af + 255 * (1 - af));
    const cab = Math.round(a.data[o + 2] * af + 255 * (1 - af));
    const cbr = Math.round(b.data[o] * bf + 255 * (1 - bf));
    const cbg = Math.round(b.data[o + 1] * bf + 255 * (1 - bf));
    const cbb = Math.round(b.data[o + 2] * bf + 255 * (1 - bf));

    srgbToLab(car, cag, cab, lab1);
    srgbToLab(cbr, cbg, cbb, lab2);
    const de = deltaE2000(lab1[0], lab1[1], lab1[2], lab2[0], lab2[1], lab2[2]);
    sumDE += de;
    if (de > maxDE) maxDE = de;

    // A full alpha flip is unmistakably "changed" even at identical composited
    // colour (a pixel appearing/disappearing); scale it onto the same rough ΔE
    // axis so one threshold governs both.
    const alphaDelta = includeAlpha ? (Math.abs(aa - ba) / 255) * 100 : 0;

    if (Math.max(de, alphaDelta) > threshold) {
      changed++;
      out[o] = dc.r; out[o + 1] = dc.g; out[o + 2] = dc.b; out[o + 3] = 255;
    } else {
      // Faded backdrop: the base image (already composited over white above),
      // washed out so the highlights read clearly against it.
      const y = luma709(car, cag, cab);
      const g = Math.round(255 * (1 - keep) + y * keep);
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
    }
  }

  return {
    image: { width, height, data: out },
    changedPixels: changed,
    totalPixels: n,
    changedFraction: n === 0 ? 0 : changed / n,
    maxDeltaE: maxDE,
    meanDeltaE: n === 0 ? 0 : sumDE / n,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
