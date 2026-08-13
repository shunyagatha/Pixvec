import { luma709 } from '../color.js';
import type { RasterImage } from '../types.js';

/**
 * Reduce an image to two colours by a luminance threshold.
 *
 * This is what potrace does before it traces: everything darker than a cutoff
 * becomes one colour, everything lighter becomes the other. It is the right tool
 * for a scanned drawing, a signature, a black-on-white logo, or any art that is
 * *meant* to be bilevel — the general colour tracer would spend a palette entry
 * on every shade of grey along an anti-aliased stroke, where this gives one
 * clean edge.
 *
 * Pure TypeScript over `RasterImage`, so it lives in the portable core.
 */

export interface ThresholdOptions {
  /**
   * Luminance cutoff, 0–255, or `'auto'` for Otsu's method. `'auto'` is the
   * sensible default: it finds the split that best separates the image's two
   * brightness populations, which beats any fixed number across scans that were
   * lit differently.
   */
  threshold?: number | 'auto';
  /**
   * `true` (default) makes dark pixels the foreground shape on a light ground —
   * the usual "black ink on white paper". `false` inverts it.
   */
  blackOnWhite?: boolean;
  /** Colour used for the foreground shape. Default black (or white when inverted). */
  foreground?: [number, number, number];
  /** Colour used for the background. Default white (or black when inverted). */
  background?: [number, number, number];
}

/**
 * Otsu's method: the threshold that minimises the variance *within* the two
 * resulting groups, equivalently the one that maximises the variance *between*
 * them. A single pass over a 256-bin luminance histogram, no iteration.
 */
export function otsuThreshold(img: RasterImage): number {
  const histogram = new Float64Array(256);
  const { data } = img;
  const n = img.width * img.height;

  let counted = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Transparent pixels have no ink; letting them vote would drag the cutoff.
    if (data[o + 3] < 128) continue;
    histogram[Math.round(luma709(data[o], data[o + 1], data[o + 2]))]++;
    counted++;
  }
  if (counted === 0) return 128;

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxBetween = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = counted - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;

    const between = weightBackground * weightForeground *
      (meanBackground - meanForeground) ** 2;
    if (between > maxBetween) {
      maxBetween = between;
      threshold = t;
    }
  }

  return threshold;
}

export interface ThresholdResult {
  image: RasterImage;
  /** The cutoff actually used, after resolving `'auto'`. */
  threshold: number;
}

/** Collapse an image to two colours at a luminance cutoff. */
export function applyThreshold(img: RasterImage, opts: ThresholdOptions = {}): ThresholdResult {
  const cutoff = opts.threshold === undefined || opts.threshold === 'auto'
    ? otsuThreshold(img)
    : opts.threshold;
  const blackOnWhite = opts.blackOnWhite ?? true;

  // `blackOnWhite` decides *which* pixels become the shape, not what colour the
  // shape is — so the fill defaults stay black-on-white regardless. Flipping the
  // colours here as well as the comparison would cancel out, leaving a dark
  // pixel black under either setting. The ink is black; the flag chooses whether
  // dark or light pixels are the ink.
  const fg = opts.foreground ?? [0, 0, 0];
  const bg = opts.background ?? [255, 255, 255];

  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const alpha = data[o + 3];
    // A transparent pixel stays transparent — thresholding is about ink, not
    // about painting over holes.
    if (alpha < 128) {
      out[o + 3] = 0;
      continue;
    }
    const lum = luma709(data[o], data[o + 1], data[o + 2]);
    // Otsu returns the cutoff `t` such that pixels with luminance <= t are the
    // dark class, so "dark is foreground" tests `lum <= cutoff`. Using `<` would
    // drop pixels sitting exactly at the returned threshold — invisible on a
    // continuous photo histogram, but wrong on clean bilevel input.
    const isForeground = blackOnWhite ? lum <= cutoff : lum > cutoff;
    const c = isForeground ? fg : bg;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }

  return { image: { width, height, data: out }, threshold: cutoff };
}
