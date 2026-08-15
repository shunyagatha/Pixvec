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
   * Compare each pixel against the average of its own neighbourhood instead of
   * one cutoff for the whole frame (Bradley–Roth).
   *
   * A single global cutoff assumes the page is lit evenly. A photograph of paper
   * is not: one corner falls into shadow, and *any* global choice either loses
   * the writing there or floods the bright side with ink. Averaging locally
   * makes the cutoff follow the lighting, so both survive. Costs one integral
   * image and stays O(pixels) — the window size does not affect the cost.
   *
   * Off by default: on evenly-lit art, Otsu is the better estimator, and this
   * would trade that for nothing.
   */
  adaptive?: boolean;
  /**
   * Neighbourhood side length in pixels. `0` (default) derives it from the
   * image: an eighth of the shorter side, which is Bradley's own suggestion and
   * comfortably larger than a stroke yet smaller than a lighting gradient.
   */
  adaptiveWindow?: number;
  /**
   * How far below the local mean a pixel must fall to count as ink, in percent.
   * Default 15, from the paper. Raising it demands darker ink and rejects more
   * paper texture; lowering it catches faint pencil at the cost of noise.
   */
  adaptiveT?: number;
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
/**
 * Bradley–Roth adaptive thresholding.
 *
 * Builds a summed-area table of luminance, then compares every pixel with the
 * mean of the window centred on it. Because the table answers any rectangle in
 * four lookups, the window size costs nothing — a 200px window is the same work
 * as a 10px one.
 *
 * Transparent pixels contribute no luminance and are not counted in the mean, so
 * a shape on a transparent ground is not dragged dark by the emptiness around it.
 *
 * Returns a per-pixel foreground mask: `1` where the pixel is ink.
 */
export function bradleyMask(img: RasterImage, window = 0, t = 15): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const mask = new Uint8Array(n);
  if (n === 0) return mask;

  // (w+1)x(h+1) so the row and column of zeros removes the bounds checks.
  const sum = new Float64Array((w + 1) * (h + 1));
  const cnt = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowCnt = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const opaque = data[o + 3] >= 128;
      if (opaque) { rowSum += luma709(data[o], data[o + 1], data[o + 2]); rowCnt++; }
      const i = (y + 1) * (w + 1) + (x + 1);
      sum[i] = rowSum + sum[i - (w + 1)];
      cnt[i] = rowCnt + cnt[i - (w + 1)];
    }
  }

  const side = window > 0 ? window : Math.max(3, Math.round(Math.min(w, h) / 8));
  const half = Math.max(1, side >> 1);
  const keep = (100 - t) / 100;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 128) continue;               // transparent: no ink
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const a = y0 * (w + 1) + x0;
      const b = y0 * (w + 1) + (x1 + 1);
      const c = (y1 + 1) * (w + 1) + x0;
      const d = (y1 + 1) * (w + 1) + (x1 + 1);
      const count = cnt[d] - cnt[b] - cnt[c] + cnt[a];
      if (count <= 0) continue;
      const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / count;
      // Ink is what sits t% below its neighbourhood, not below a global number.
      if (luma709(data[o], data[o + 1], data[o + 2]) <= mean * keep) mask[y * w + x] = 1;
    }
  }
  return mask;
}

export function applyThreshold(img: RasterImage, opts: ThresholdOptions = {}): ThresholdResult {
  const adaptive = opts.adaptive === true;
  // The mask is computed once for the whole image; the per-pixel loop below then
  // reads it instead of comparing against a single number.
  const mask = adaptive
    ? bradleyMask(img, opts.adaptiveWindow ?? 0, opts.adaptiveT ?? 15)
    : null;
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
    // Adaptive decides ink from the neighbourhood; `blackOnWhite` still chooses
    // which side of that decision is the shape, so inverted art works either way.
    const dark = mask ? mask[i] === 1 : lum <= cutoff;
    const isForeground = blackOnWhite ? dark : !dark;
    const c = isForeground ? fg : bg;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }

  return { image: { width, height, data: out }, threshold: cutoff };
}
